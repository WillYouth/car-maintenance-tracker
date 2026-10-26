const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./db');

const adminEmails = db.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1");
let transport = null;

// Plain text only: no parse_mode, so driver-entered text can never break the message.
async function telegram(text) {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

// Node has no built-in SMTP client; nodemailer is the small, standard choice.
async function email(subject, text) {
  if (!config.smtp.host) return;
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  const to = adminEmails.all().map((r) => r.email);
  if (to.length) await transport.sendMail({ from: config.smtp.from, to, subject, text });
}

async function alertWarning({ vehicle, driver, phase, flags }) {
  const text = `Warning: ${vehicle}: ${flags.join(', ')}\nDriver: ${driver} (${phase}-ride check)\n${new Date().toLocaleString('en-GB')}`;
  const results = await Promise.allSettled([telegram(text), email(`Car alert: ${vehicle}`, text)]);
  for (const r of results) if (r.status === 'rejected') console.error('Alert delivery failed:', r.reason.message);
}

module.exports = { alertWarning };
