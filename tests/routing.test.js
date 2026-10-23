const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/shared/routing.js');

test('providerOrder puts Clef before Groq and keeps Nano first when usable', async () => {
  const { providerOrder } = await load();
  const nanoEn = { availability: 'available', arabic: false };
  const nanoAr = { availability: 'available', arabic: true };

  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: true, hasGroq: true }),
    ['nano', 'clef', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoAr, arabic: true, hasClef: true, hasGroq: true }),
    ['nano', 'clef', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: true, hasClef: true, hasGroq: true }),
    ['clef', 'groq', 'nano'],
  );
});

test('providerOrder preserves the old chain when Clef is absent', async () => {
  const { providerOrder } = await load();
  const nanoEn = { availability: 'available', arabic: false };

  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: false, hasGroq: true }),
    ['nano', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: false, hasGroq: false }),
    ['nano'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: null, arabic: false, hasClef: true, hasGroq: false }),
    ['clef'],
  );
});

test('clefBackoffUntil handles auth, quota, and transient errors', async () => {
  const { clefBackoffUntil } = await load();
  const now = Date.UTC(2026, 9, 23, 15, 30);

  assert.equal(clefBackoffUntil({ status: 401 }, now), Infinity);
  assert.equal(clefBackoffUntil({ status: 403 }, now), Infinity);
  assert.equal(clefBackoffUntil({ status: 429 }, now), Date.UTC(2026, 9, 24));
  assert.equal(clefBackoffUntil({ status: 500 }, now), 0);
  assert.equal(clefBackoffUntil(new Error('network'), now), 0);
});
