// Runs with `node --test` - no DB needed, only the liveness route is exercised.
process.env.DB_WRITE_URL = 'postgres://u:p@localhost:5432/none';

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');

test('GET /api/health returns ok', async () => {
  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'ok' });
  server.close();
  process.exit(0); // pg/redis handles are lazy but keep the process tidy
});
