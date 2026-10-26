const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('./config');
require('./db'); // opens the database and applies the schema before serving
const { tokenMatches, buildIcs } = require('./ics');
const routes = require('./routes');

fs.mkdirSync(config.uploadDir, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Nginx is the only client-facing hop
app.use(express.json({ limit: '16kb' }));

app.use('/api', routes);

// Subscription feed: unguessable token in the path, served as text/calendar.
app.get('/calendar/:file', (req, res) => {
  const match = /^(.+)\.ics$/.exec(req.params.file);
  if (!match || !tokenMatches(match[1])) return res.status(404).end();
  res.type('text/calendar').set('Cache-Control', 'private, max-age=900').send(buildIcs());
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.expose ? err.message : 'Server error';
  if (err.code === 'LIMIT_FILE_SIZE') { status = 413; message = 'Image is too large (max 4 MB)'; }
  if (String(err.code).startsWith('SQLITE_CONSTRAINT')) { status = 409; message = 'Duplicate or conflicting value'; }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

// Bind to loopback only; Nginx terminates TLS and proxies in.
app.listen(config.port, '127.0.0.1', () => {
  console.log(`Car tracker listening on 127.0.0.1:${config.port}`);
});
