#!/usr/bin/env node
// Smoke test: verifies GEMINI_API_KEY works with a real gemini-3.8-flash call.
// Run:  npm run gemini:smoke
const { generateText, generateJson, MODEL } = require('../src/lib/gemini');

const checks = [
  {
    name: 'text reply',
    run: () => generateText('Reply with exactly one word: pong'),
    ok: (text) => /pong/i.test(text),
    show: (text) => JSON.stringify(text.trim()),
  },
  {
    name: 'structured JSON',
    run: () => generateJson({
      system: 'Return the requested JSON object.',
      prompt: 'Set "ok" to true and "model" to the string "smoke".',
      schema: {
        type: 'OBJECT',
        properties: { ok: { type: 'BOOLEAN' }, model: { type: 'STRING' } },
        required: ['ok', 'model'],
      },
    }),
    ok: (obj) => obj.ok === true && obj.model === 'smoke',
    show: (obj) => JSON.stringify(obj),
  },
];

(async () => {
  console.log(`Model: ${MODEL}`);
  let failed = 0;
  for (const check of checks) {
    const started = Date.now();
    try {
      const result = await check.run();
      const passed = check.ok(result);
      if (!passed) failed += 1;
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${check.name} (${Date.now() - started} ms)  ${check.show(result)}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${check.name}: ${err.message}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} check(s) failed. Confirm GEMINI_API_KEY in .env is a valid AI Studio key.`);
    process.exit(1);
  }
  console.log('\nGemini API is responding correctly.');
})();
