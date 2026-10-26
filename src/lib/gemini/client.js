const { GoogleGenAI } = require('@google/genai');
const config = require('../../config'); // loads .env / .env.local

const MODEL = 'gemini-3.5-flash-lite';
const PLACEHOLDER_KEY = 'your_gemini_api_key_here';
const TIMEOUT_MS = 60_000;

let client = null;

// Lazily created so the app still boots (and serves manual entry) without a key.
function getClient() {
  const key = config.geminiApiKey.trim();
  if (!key || key === PLACEHOLDER_KEY) {
    throw new Error('GEMINI_API_KEY is not set. Add your key to .env (see .env.example).');
  }
  client ??= new GoogleGenAI({ apiKey: key, httpOptions: { timeout: TIMEOUT_MS } });
  return client;
}

module.exports = { getClient, MODEL };
