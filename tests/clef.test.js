const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/shared/clef.js');

test('buildClefRequest creates a 7-option choice question', async () => {
  const { buildClefRequest } = await load();
  const req = buildClefRequest('We are hiring', 'clef');
  assert.equal(req.model, 'clef');
  assert.equal(req.state, 'We are hiring');
  assert.equal(req.questions.category.type, 'choice');
  assert.match(req.questions.category.instructions, /LinkedIn post/);
  assert.deepEqual(
    Object.keys(req.questions.category.criteria).sort(),
    ['advice', 'complaint', 'event', 'offer', 'opportunity', 'other', 'story'],
  );
});

test('resolveClefModel accepts known models and defaults unknown ones', async () => {
  const { resolveClefModel } = await load();
  assert.equal(resolveClefModel('clef-omni'), 'clef-omni');
  assert.equal(resolveClefModel('clef'), 'clef');
  assert.equal(resolveClefModel('bogus'), 'clef-flash');
  assert.equal(resolveClefModel(undefined), 'clef-flash');
});

test('parseClefResponse returns the selected category and confidence', async () => {
  const { parseClefResponse } = await load();
  const data = {
    success: true,
    result: {
      answers: {
        category: {
          type: 'choice',
          choice: 'opportunity',
          confidence: 0.91,
          probabilities: { opportunity: 0.91, other: 0.09 },
        },
      },
    },
  };
  assert.deepEqual(parseClefResponse(data), {
    category: 'opportunity',
    confidence: 0.91,
    probabilities: { opportunity: 0.91, other: 0.09 },
  });
});

test('parseClefResponse rejects failed envelopes and unknown categories', async () => {
  const { parseClefResponse } = await load();
  assert.equal(parseClefResponse({ success: false, errors: [] }), null);
  assert.equal(parseClefResponse({ success: true, result: { answers: {} } }), null);
  assert.equal(
    parseClefResponse({
      success: true,
      result: { answers: { category: { choice: 'vacation' } } },
    }),
    null,
  );
});

test('classifyClef posts to the selected model and returns the parsed answer', async (t) => {
  const { classifyClef } = await load();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          answers: {
            category: { choice: 'event', confidence: 0.8, probabilities: { event: 0.8 } },
          },
        },
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await classifyClef('Join our webinar', {
    cloudflareAccountId: 'acc 1',
    cloudflareApiKey: 'tok',
    clefModel: 'clef-omni',
  });

  assert.deepEqual(result, {
    category: 'event',
    confidence: 0.8,
    probabilities: { event: 0.8 },
  });
  assert.match(calls[0].url, /accounts\/acc%201\/ai\/run\/@cf\/cloudflare\/clef-omni$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(calls[0].options.body).model, 'clef-omni');
});

test('classifyClef tags quota and auth errors', async (t) => {
  const { classifyClef } = await load();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const respond = (status, message) => {
    globalThis.fetch = async () => ({
      ok: false,
      status,
      json: async () => ({ success: false, errors: [{ message }] }),
    });
  };

  respond(429, 'Daily neuron limit reached');
  await assert.rejects(
    () => classifyClef('x', { cloudflareAccountId: 'a', cloudflareApiKey: 'k' }),
    (err) => err.status === 429 && err.quota === true,
  );

  respond(403, 'Authentication error');
  await assert.rejects(
    () => classifyClef('x', { cloudflareAccountId: 'a', cloudflareApiKey: 'k' }),
    (err) => err.status === 403 && err.quota === false,
  );
});
