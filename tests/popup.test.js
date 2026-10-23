const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('src/popup/popup.html', 'utf8');
const js = fs.readFileSync('src/popup/popup.js', 'utf8');

test('Cloudflare fields exist in the popup', () => {
  for (const id of ['useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('Cloudflare section comes before Groq', () => {
  assert.match(html, /Cloudflare Clef \(primary\)/i);
  assert.match(html, /Groq \(secondary fallback\)/i);
  assert.ok(html.indexOf('Cloudflare Clef (primary)') < html.indexOf('Groq (secondary fallback)'));
});

test('popup FIELDS include the Cloudflare settings', () => {
  for (const key of ['useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel']) {
    assert.match(js, new RegExp(`'${key}'`));
  }
});

test('popup offers only the supported Clef models', () => {
  assert.match(html, /id="clefModel"/);
  assert.doesNotMatch(html, /clef-omni/i);
});
