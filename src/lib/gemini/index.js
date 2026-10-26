const { getClient, MODEL } = require('./client');

const RETRYABLE_STATUS = new Set([503, 504]);
const MAX_RETRIES = 1;
const BASE_DELAY_MS = 2_000; // doubles on each retry: 2s, 4s, ...

// The SDK error carries an HTTP status; fall back to parsing the JSON body in the message.
function statusOf(err) {
  if (typeof err?.status === 'number') return err.status;
  const match = /"code":\s*(\d{3})/.exec(String(err?.message ?? ''));
  return match ? Number(match[1]) : null;
}

// Retries transient overload (503) and deadline (504) errors with exponential backoff.
async function withRetry(request) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      const retryable = RETRYABLE_STATUS.has(statusOf(err));
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
    }
  }
}

// Plain-text helper: returns the model's text reply.
async function generateText(prompt, { system, model = MODEL } = {}) {
  const res = await withRetry(() => getClient().models.generateContent({
    model,
    contents: prompt,
    config: system ? { systemInstruction: system } : undefined,
  }));
  return res.text;
}

// Structured helper: optional image in, JSON that matches `schema` out.
async function generateJson({ prompt, system, schema, image, mime, model = MODEL, maxOutputTokens = 1024 }) {
  const parts = [{ text: prompt }];
  if (image) parts.unshift({ inlineData: { mimeType: mime, data: image.toString('base64') } });

  const res = await withRetry(() => getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0,
      maxOutputTokens,
    },
  }));

  if (!res.text) {
    throw new Error(`Gemini returned no content (finishReason=${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
  }
  return JSON.parse(res.text);
}

module.exports = { generateText, generateJson, MODEL };
