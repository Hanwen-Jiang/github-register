const test = require('node:test');
const assert = require('node:assert/strict');
const sites = require('../lib/sites');

test('resolveTargetSites returns all sites for empty filter', () => {
  const all = sites.resolveTargetSites('');
  assert.deepEqual(all.map(s => s.name).sort(), ['a6api', 'cun.ai']);
});

test('resolveTargetSites filters by name substring', () => {
  assert.deepEqual(sites.resolveTargetSites('cun.ai').map(s => s.name), ['cun.ai']);
  assert.deepEqual(sites.resolveTargetSites('a6api').map(s => s.name), ['a6api']);
});

test('resolveTargetSites filters by baseUrl substring', () => {
  assert.deepEqual(sites.resolveTargetSites('a6api.com').map(s => s.name), ['a6api']);
});

test('resolveTargetSites supports comma-separated multi-filter', () => {
  const r = sites.resolveTargetSites('cun.ai,a6api').map(s => s.name).sort();
  assert.deepEqual(r, ['a6api', 'cun.ai']);
});

test('resolveTargetSites unknown filter yields empty (future site not yet added)', () => {
  assert.deepEqual(sites.resolveTargetSites('doesnotexist'), []);
});

test('resolveRoutingProfiles returns 4 defaults when env absent', () => {
  assert.equal(sites.resolveRoutingProfiles('').length, 4);
  assert.equal(sites.resolveRoutingProfiles(undefined).length, 4);
});

test('resolveRoutingProfiles parses a JSON override', () => {
  const custom = sites.resolveRoutingProfiles(JSON.stringify([{ name: 'x' }]));
  assert.equal(custom.length, 1);
  assert.equal(custom[0].name, 'x');
});

test('resolveRoutingProfiles falls back on bad JSON', () => {
  assert.equal(sites.resolveRoutingProfiles('{not json').length, 4);
});
