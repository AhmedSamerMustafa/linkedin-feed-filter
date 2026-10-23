const test = require('node:test');
const assert = require('node:assert');

// Minimal chrome.storage.local stand-in: enough for settings, the AI cache, and the
// persisted Clef quota deadline.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (key) => { delete store[key]; },
    },
  },
  runtime: { onMessage: { addListener: () => {} } },
};

const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).includes('cloudflare')) {
    return {
      ok: false,
      status: 429,
      json: async () => ({ success: false, errors: [{ message: 'Daily neuron limit reached' }] }),
    };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: '{"category":"advice"}' } }] }),
  };
};

Object.assign(store, {
  useNano: false,
  useClef: true,
  cloudflareAccountId: 'acc',
  cloudflareApiKey: 'key',
  groqKey: 'groq-key',
  groqModel: 'test-model',
});

test('quota backoff survives a service-worker restart', async () => {
  const firstWorker = await import('../src/background.js');

  const first = await firstWorker.runLLMChain('We are hiring', false);
  assert.equal(first.source, 'groq', 'Clef 429 should fall through to Groq');
  assert.equal(fetchCalls.filter((url) => url.includes('cloudflare')).length, 1);
  assert.ok(store.clefQuotaUntil > Date.now(), 'the quota deadline should be persisted');

  // A fresh module instance is what Chrome gives you after recycling the worker:
  // in-memory state resets, chrome.storage.local does not.
  const restartedWorker = await import('../src/background.js?restart=1');
  const before = fetchCalls.length;
  const second = await restartedWorker.runLLMChain('Join our webinar', false);

  assert.equal(second.source, 'groq');
  assert.equal(
    fetchCalls.slice(before).filter((url) => url.includes('cloudflare')).length,
    0,
    'a restarted worker must not call Cloudflare again before the deadline',
  );
});
