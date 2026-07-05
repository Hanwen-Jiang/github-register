const test = require('node:test');
const assert = require('node:assert/strict');
const { computeNeed } = require('../lib/pool-watcher');

test('computeNeed: idle when usable meets target', () => {
  const r = computeNeed({ usable: 15, velocity: 0, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.target, 15);
  assert.equal(r.need, 0);
  assert.equal(r.toRegister, 0);
});

test('computeNeed: raises target by ceil(velocity*lookahead)', () => {
  // velocity 3.2/hr, lookahead 1h -> target 15+4=19; usable 15 -> need 4
  const r = computeNeed({ usable: 15, velocity: 3.2, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.target, 19);
  assert.equal(r.need, 4);
  assert.equal(r.toRegister, 4);
});

test('computeNeed: caps toRegister at maxPerRun', () => {
  const r = computeNeed({ usable: 2, velocity: 0, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.need, 13);
  assert.equal(r.toRegister, 5);
});
