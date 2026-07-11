const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('normalizeLiveGroupOptions converts an object map into stable selectable options', () => {
  const { normalizeLiveGroupOptions } = require('../lib/site-groups');
  const options = normalizeLiveGroupOptions({
    default: { desc: '默认分组', ratio: 1 },
    vip: { description: 'VIP 通道', ratio: 0.5 },
  });

  assert.deepEqual(options, [
    { value: 'default', label: '默认分组', description: '默认分组', ratio: 1, source: 'live' },
    { value: 'vip', label: 'VIP 通道', description: 'VIP 通道', ratio: 0.5, source: 'live' },
  ]);
});

test('normalizeLiveGroupOptions accepts array-shaped group responses', () => {
  const { normalizeLiveGroupOptions } = require('../lib/site-groups');
  assert.deepEqual(normalizeLiveGroupOptions([
    { name: 'team', desc: 'Team', ratio: 2 },
    { value: 'default', label: 'Default' },
  ]), [
    { value: 'team', label: 'Team', description: 'Team', ratio: 2, source: 'live' },
    { value: 'default', label: 'Default', description: 'Default', ratio: undefined, source: 'live' },
  ]);
});

test('fallbackGroupOptions exposes routing profiles only for a6api', () => {
  const { fallbackGroupOptions } = require('../lib/site-groups');
  const routingProfiles = [
    { name: 'dynamic-cheap', routing_enabled: true, routing_preference: 'cheap' },
    { name: 'dynamic-fast', routing_enabled: true, routing_preference: 'fast' },
  ];

  const a6 = fallbackGroupOptions({ name: 'a6api', tokenGroup: 'default' }, routingProfiles);
  assert.deepEqual(a6.map(option => ({ value: option.value, source: option.source, routing: option.routing.routing_preference })), [
    { value: 'dynamic-cheap', source: 'fallback-routing', routing: 'cheap' },
    { value: 'dynamic-fast', source: 'fallback-routing', routing: 'fast' },
  ]);

  const cun = fallbackGroupOptions({ name: 'cun.ai', tokenGroup: 'default' }, routingProfiles);
  assert.deepEqual(cun, [{ value: 'default', label: 'default', description: '站点默认分组', source: 'fallback-default' }]);

  const xyc = fallbackGroupOptions({ name: 'xyc.ai', tokenGroup: '' }, routingProfiles);
  assert.deepEqual(xyc, [{ value: '', label: '(空分组)', description: '站点默认分组', source: 'fallback-default' }]);
});

test('parseGroupMultiSelection supports indices, values, deduplication, and all', () => {
  const { parseGroupMultiSelection } = require('../lib/site-groups');
  const options = [
    { value: 'default', label: 'Default' },
    { value: 'vip', label: 'VIP' },
    { value: 'team', label: 'Team' },
  ];

  assert.deepEqual(parseGroupMultiSelection('1,3,default', options).map(item => item.value), ['default', 'team']);
  assert.deepEqual(parseGroupMultiSelection('vip', options).map(item => item.value), ['vip']);
  assert.deepEqual(parseGroupMultiSelection('all', options).map(item => item.value), ['default', 'vip', 'team']);
  assert.throws(() => parseGroupMultiSelection('', options), /at least one/i);
  assert.throws(() => parseGroupMultiSelection('missing', options), /invalid group selection/i);
});

test('promptSiteGroupSelection renders choices and delegates multi-selection parsing', async () => {
  const { promptSiteGroupSelection } = require('../lib/site-groups');
  const calls = [];
  const selected = await promptSiteGroupSelection({ name: 'a6api' }, [
    { value: 'default', label: '默认分组', ratio: 1 },
    { value: 'vip', label: 'VIP', ratio: 2 },
  ], {
    promptFn: async payload => {
      calls.push(payload);
      return '1,2';
    },
  });

  assert.deepEqual(selected.map(item => item.value), ['default', 'vip']);
  assert.equal(calls[0].site.name, 'a6api');
  assert.equal(calls[0].message.includes('默认分组'), true);
  assert.equal(calls[0].message.includes('VIP'), true);
});

test('group config round-trips atomically and validates target sites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-groups-'));
  const file = path.join(dir, 'nested', 'groups.json');
  const config = {
    version: 1,
    savedAt: '2026-07-11T00:00:00.000Z',
    uploadGroup: { id: 9, name: 'Claude 渠道' },
    sites: {
      a6api: { source: 'live', selected: [{ value: 'default', label: '默认分组', source: 'live' }] },
    },
  };
  const { writeGroupConfig, readGroupConfig } = require('../lib/site-groups');

  writeGroupConfig(file, config);
  assert.deepEqual(readGroupConfig(file, [{ name: 'a6api' }]), config);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp-')), false);
  assert.throws(() => readGroupConfig(file, [{ name: 'a6api' }, { name: 'cun.ai' }]), /missing target site.*cun\.ai/i);

  fs.writeFileSync(file, JSON.stringify({ ...config, version: 2 }));
  assert.throws(() => readGroupConfig(file, [{ name: 'a6api' }]), /unsupported group config version/i);
});
