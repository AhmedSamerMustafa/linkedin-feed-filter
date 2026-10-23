const test = require('node:test');
const assert = require('node:assert');

test('Cloudflare settings defaults are present', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/shared/settings.js');
  assert.equal(DEFAULT_SETTINGS.useClef, true);
  assert.equal(DEFAULT_SETTINGS.cloudflareAccountId, '');
  assert.equal(DEFAULT_SETTINGS.cloudflareApiKey, '');
  assert.equal(DEFAULT_SETTINGS.clefModel, 'clef-flash');
});

test('manifest grants the Cloudflare host permission', () => {
  const manifest = require('../manifest.json');
  assert.ok(manifest.host_permissions.includes('https://api.cloudflare.com/*'));
});
