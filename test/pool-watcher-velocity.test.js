const test = require('node:test');
const assert = require('node:assert/strict');
const { depletionRate } = require('../lib/pool-watcher');

const HOUR = 3600 * 1000;

test('depletionRate returns 0 with fewer than 2 snapshots', () => {
  assert.equal(depletionRate([]), 0);
  assert.equal(depletionRate([{ usable: 10, t: 0 }]), 0);
});

test('depletionRate measures accounts lost per hour', () => {
  // 20 -> 14 over 2 hours = 3/hr
  const snaps = [{ usable: 20, t: 0 }, { usable: 14, t: 2 * HOUR }];
  assert.equal(depletionRate(snaps), 3);
});

test('depletionRate clamps growth (net increase) to 0', () => {
  const snaps = [{ usable: 10, t: 0 }, { usable: 18, t: HOUR }];
  assert.equal(depletionRate(snaps), 0);
});

test('depletionRate returns 0 when time span is 0', () => {
  assert.equal(depletionRate([{ usable: 20, t: 5 }, { usable: 10, t: 5 }]), 0);
});
