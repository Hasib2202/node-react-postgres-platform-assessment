const { Pool } = require('pg');
const config = require('./config');

// Two pools = the read/write split. Writes (and anything that must read its own
// writes) use `writer`; list/read endpoints use `reader`. In this local setup both
// URLs can point at the same server; in production the reader would be a replica.
const writer = new Pool({ connectionString: config.db.writeUrl, max: 10 });
const reader = new Pool({ connectionString: config.db.readUrl, max: 10 });

for (const [name, pool] of [['writer', writer], ['reader', reader]]) {
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: `pg ${name} pool error`, err: err.message })));
}

module.exports = { writer, reader };
