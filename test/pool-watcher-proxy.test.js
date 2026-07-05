const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProxyRotator } = require('../lib/pool-watcher');

test('makeProxyRotator round-robins and wraps', () => {
  const next = makeProxyRotator(['a', 'b', 'c']);
  assert.equal(next(), 'a');
  assert.equal(next(), 'b');
  assert.equal(next(), 'c');
  assert.equal(next(), 'a');
});

test('makeProxyRotator returns null for empty list', () => {
  const next = makeProxyRotator([]);
  assert.equal(next(), null);
  assert.equal(next(), null);
});

test('makeProxyRotator handles single proxy', () => {
  const next = makeProxyRotator(['only']);
  assert.equal(next(), 'only');
  assert.equal(next(), 'only');
});
