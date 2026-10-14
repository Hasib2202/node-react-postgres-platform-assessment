const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const config = require('./config');

// Shared by API (producer) and worker (consumer). maxRetriesPerRequest:null is
// required by BullMQ workers; lazyConnect keeps the API booting if Redis is down.
function createConnection() {
  const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  connection.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: err.message })));
  return connection;
}

let cached;
function getRedis() {
  if (!cached) cached = createConnection();
  return cached;
}

let queue;
function getQueue() {
  if (!queue) queue = new Queue(config.queueName, { connection: getRedis() });
  return queue;
}

module.exports = { createConnection, getRedis, getQueue };
