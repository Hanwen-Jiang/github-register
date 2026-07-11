const test = require('node:test');
const assert = require('node:assert/strict');
const sites = require('../lib/sites');

test('resolveTargetSites returns all sites for empty filter', () => {
  const all = sites.resolveTargetSites('');
  assert.deepEqual(all.map(s => s.name).sort(), ['a6api', 'cun.ai', 'xyc.ai']);
});

test('resolveTargetSites filters by name substring', () => {
  assert.deepEqual(sites.resolveTargetSites('cun.ai').map(s => s.name), ['cun.ai']);
  assert.deepEqual(sites.resolveTargetSites('a6api').map(s => s.name), ['a6api']);
  assert.deepEqual(sites.resolveTargetSites('xyc.ai').map(s => s.name), ['xyc.ai']);
});

test('resolveTargetSites filters by baseUrl substring', () => {
  assert.deepEqual(sites.resolveTargetSites('a6api.com').map(s => s.name), ['a6api']);
  assert.deepEqual(sites.resolveTargetSites('xyc.ai').map(s => s.name), ['xyc.ai']);
});

test('resolveTargetSites supports comma-separated multi-filter', () => {
  const r = sites.resolveTargetSites('cun.ai,a6api,xyc').map(s => s.name).sort();
  assert.deepEqual(r, ['a6api', 'cun.ai', 'xyc.ai']);
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

test('only cun.ai defaults to randomized finite quota above 20 USD', () => {
  const byName = Object.fromEntries(sites.SITES.map(site => [site.name, site]));

  assert.equal(byName['cun.ai'].tokenUnlimitedQuota, false);
  assert.equal(byName['cun.ai'].tokenRemainQuotaRandom, true);
  assert.equal(byName['cun.ai'].tokenRemainQuotaMinUsd, 21);
  assert.equal(byName['cun.ai'].tokenRemainQuotaMaxUsd, 50);

  assert.equal(byName.a6api.tokenUnlimitedQuota, true);
  assert.equal(byName.a6api.tokenRemainQuota, 0);
  assert.equal(byName.a6api.tokenRemainQuotaRandom, undefined);

  assert.equal(byName['xyc.ai'].tokenUnlimitedQuota, true);
  assert.equal(byName['xyc.ai'].tokenRemainQuota, 0);
  assert.equal(byName['xyc.ai'].tokenRemainQuotaRandom, undefined);
});
