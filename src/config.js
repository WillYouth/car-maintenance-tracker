const path = require('node:path');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
// Precedence: real environment variables > .env.local > .env (dotenv never overrides existing vars).
dotenv.config({ path: path.join(root, '.env.local'), quiet: true });
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  publicUrl: env.PUBLIC_URL || 'http://localhost:3000',
  dbPath: path.resolve(root, env.DB_PATH || 'data/app.db'),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || 'data/uploads'),
  cookieSecure: env.COOKIE_SECURE !== 'false',
  sessionDays: 14,

  // Business rules
  serviceIntervalKm: 10000,
  serviceIntervalMonths: 6,
  maxKmPerRide: 1500, // above this, the ride is flagged for review

  geminiApiKey: env.GEMINI_API_KEY || '',

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'Car Tracker <alerts@example.com>',
  },
};
