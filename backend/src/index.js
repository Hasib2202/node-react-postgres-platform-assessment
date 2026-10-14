const app = require('./app');
const config = require('./config');
const { writer, reader } = require('./db');

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'api', level: 'info', msg: `listening on ${config.port}` }));
});

// Graceful shutdown so rolling updates don't drop in-flight requests.
function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', msg: `${signal} received, draining` }));
  server.close(async () => {
    await Promise.allSettled([writer.end(), reader.end()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
