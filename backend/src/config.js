// All configuration comes from environment variables - nothing is hardcoded.
const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// DB_WRITE_URL / DB_READ_URL win when set (Task 5). Otherwise the URL is
// assembled from the discrete DB_* variables (Task 1).
function dbUrlFromParts() {
  const user = encodeURIComponent(required('DB_USER'));
  const password = encodeURIComponent(required('DB_PASSWORD'));
  const host = required('DB_HOST');
  const port = env.DB_PORT || '5432';
  const name = required('DB_NAME');
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

const writeUrl = env.DB_WRITE_URL || dbUrlFromParts();

module.exports = {
  port: Number(env.PORT || 4000),
  corsOrigin: env.CORS_ORIGIN || '', // empty = same-origin only (Ingress setup)
  db: {
    writeUrl,
    readUrl: env.DB_READ_URL || writeUrl,
  },
  redis: {
    host: env.REDIS_HOST || 'redis',
    port: Number(env.REDIS_PORT || 6379),
  },
  queueName: env.QUEUE_NAME || 'todo-events',
  searchUrl: env.SEARCH_URL || 'http://search:9200',
};
