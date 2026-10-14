const express = require('express');
const cors = require('cors');
const client = require('prom-client');
const config = require('./config');
const { writer, reader } = require('./db');
const { getQueue, getRedis } = require('./queue');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin.split(',') }));

// ---- metrics ---------------------------------------------------------------
client.collectDefaultMetrics();
const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// Structured JSON access log (easy to filter in Loki with `| json`).
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    const labels = { method: req.method, route, status: res.statusCode };
    httpRequests.inc(labels);
    httpDuration.observe(labels, seconds);
    if (route !== '/metrics') {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), svc: 'api', level: res.statusCode >= 500 ? 'error' : 'info',
        msg: 'request', method: req.method, path: req.originalUrl, status: res.statusCode,
        ms: Math.round(seconds * 1000),
      }));
    }
  });
  next();
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ---- health ----------------------------------------------------------------
// Liveness: process is up. Must NOT depend on downstream systems, otherwise a DB
// blip makes Kubernetes restart healthy pods.
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Readiness: can this pod serve traffic? Needs the primary and the read pool.
// Redis/search are deliberately excluded - the CRUD path still works without them.
app.get('/api/ready', async (_req, res) => {
  try {
    await Promise.all([writer.query('SELECT 1'), reader.query('SELECT 1')]);
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not-ready', error: err.message });
  }
});

// ---- todos -----------------------------------------------------------------
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get('/api/todos', wrap(async (_req, res) => {
  // Read endpoint -> replica pool (eventually consistent).
  const { rows } = await reader.query('SELECT id, title, done, created_at, processed_at FROM todos ORDER BY id DESC LIMIT 100');
  res.json(rows);
}));

app.post('/api/todos', wrap(async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title || title.length > 200) return res.status(400).json({ error: 'title is required (max 200 chars)' });
  // Write -> primary. RETURNING gives the client its own row without a replica read.
  const { rows } = await writer.query(
    'INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at, processed_at',
    [title],
  );
  try {
    await getQueue().add('todo-created', { todoId: rows[0].id }, { removeOnComplete: 100, removeOnFail: 500 });
  } catch (err) {
    // Degrade gracefully: the todo is saved even if the queue is unavailable.
    console.error(JSON.stringify({ level: 'error', msg: 'enqueue failed', err: err.message }));
  }
  res.status(201).json(rows[0]);
}));

app.patch('/api/todos/:id', wrap(async (req, res) => {
  const { rows } = await writer.query(
    'UPDATE todos SET done = COALESCE($2, done) WHERE id = $1 RETURNING id, title, done, created_at, processed_at',
    [req.params.id, typeof req.body.done === 'boolean' ? req.body.done : null],
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

app.delete('/api/todos/:id', wrap(async (req, res) => {
  const { rowCount } = await writer.query('DELETE FROM todos WHERE id = $1', [req.params.id]);
  res.status(rowCount ? 204 : 404).end();
}));

// ---- platform status (Task 5 wiring check) -----------------------------------
async function probe(fn) {
  const started = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

app.get('/api/platform/status', wrap(async (_req, res) => {
  const [dbWrite, dbRead, redis, search] = await Promise.all([
    probe(() => writer.query('SELECT 1')),
    probe(() => reader.query('SELECT 1')),
    probe(async () => {
      const redisClient = getRedis();
      if (redisClient.status === 'wait') await redisClient.connect();
      return redisClient.ping();
    }),
    probe(async () => {
      const r = await fetch(`${config.searchUrl}/_cluster/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }),
  ]);
  res.json({ dbWrite, dbRead, redis, search });
}));

// ---- errors ----------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), svc: 'api', level: 'error', msg: err.message }));
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
