const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');

const COOKIE = 'sid';
const TTL_MS = config.sessionDays * 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const q = {
  purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  insert: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  lookup: db.prepare(`
    SELECT u.id, u.email, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`),
  remove: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function startSession(res, userId) {
  q.purge.run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  q.insert.run(sha256(token), userId, Date.now() + TTL_MS);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict', // blocks cross-site form posts (CSRF) without extra tokens
    maxAge: TTL_MS,
    path: '/',
  });
}

function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) q.remove.run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function requireAuth(req, res, next) {
  const token = readCookie(req, COOKIE);
  const user = token && q.lookup.get(sha256(token), Date.now());
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' })));
}

// Simple in-memory login throttle: 10 attempts per IP per 15 minutes.
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  if (attempts.size > 500) attempts.clear();
  const entry = attempts.get(ip);
  if (!entry || now > entry.reset) {
    attempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

module.exports = { startSession, endSession, requireAuth, requireAdmin, loginAllowed };
