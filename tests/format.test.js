const test = require('node:test');
const assert = require('node:assert');
require('../src/content/format.js');

const { badgeLabel, formatConfidence } = globalThis.LIF.format;

test('formatConfidence renders percentages and ignores missing values', () => {
  assert.equal(formatConfidence(0.873), '87%');
  assert.equal(formatConfidence(0), '0%');
  assert.equal(formatConfidence(null), null);
  assert.equal(formatConfidence('0.9'), null);
});

test('badgeLabel omits missing parts', () => {
  assert.equal(badgeLabel('opportunity', 'clef', 0.91), 'opportunity · clef · 91%');
  assert.equal(badgeLabel('promoted', 'ad', null), 'promoted · ad');
  assert.equal(badgeLabel(undefined, undefined, undefined), '');
});
