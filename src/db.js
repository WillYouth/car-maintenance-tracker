const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');     // readers never block the writer
db.pragma('synchronous = NORMAL');   // safe with WAL, far fewer fsyncs on SD cards
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 3000');
db.pragma('cache_size = -2048');     // ~2 MB page cache
db.pragma('temp_store = MEMORY');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = db;
