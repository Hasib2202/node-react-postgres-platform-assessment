// BullMQ consumer. Runs as its own Deployment/container (bullmq-worker) so queue
// throughput scales independently from the HTTP API.
const { Worker } = require('bullmq');
const config = require('./config');
const { createConnection } = require('./queue');
const { writer } = require('./db');

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'worker', ...obj }));

const worker = new Worker(
  config.queueName,
  async (job) => {
    const { todoId } = job.data;
    // Marking a row processed is a write -> always the primary.
    await writer.query('UPDATE todos SET processed_at = now() WHERE id = $1', [todoId]);
    log({ level: 'info', msg: 'job processed', jobId: job.id, todoId });
  },
  { connection: createConnection(), concurrency: 5 },
);

worker.on('failed', (job, err) => log({ level: 'error', msg: 'job failed', jobId: job && job.id, err: err.message }));
worker.on('error', (err) => log({ level: 'error', msg: 'worker error', err: err.message }));
log({ level: 'info', msg: 'worker started', queue: config.queueName });

async function shutdown() {
  await worker.close();
  await writer.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
