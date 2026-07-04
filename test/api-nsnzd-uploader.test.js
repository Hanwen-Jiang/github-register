const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAnthropicAccountPayload,
  buildModelMappingFromIntersection,
  formatUtcTimestamp,
  normalizeAdminKey,
  siteSlug,
} = require('../lib/api-nsnzd-uploader');

test('normalizeAdminKey trims whitespace and surrounding quotes', () => {
  assert.equal(normalizeAdminKey('  "admin-abc"  '), 'admin-abc');
  assert.equal(normalizeAdminKey("\t'admin-xyz'\r"), 'admin-xyz');
});

test('formatUtcTimestamp formats timestamps for account names', () => {
  assert.equal(formatUtcTimestamp(new Date('2026-07-04T19:44:10Z')), '20260704194410');
});

test('siteSlug normalizes target sites for register account names', () => {
  assert.equal(siteSlug({ site: 'cun.ai', baseUrl: 'https://www.cun.ai' }), 'cun');
  assert.equal(siteSlug({ site: 'a6api', baseUrl: 'https://a6api.com' }), 'a6api');
});

test('buildModelMappingFromIntersection keeps only upstream Claude models as identity mapping', () => {
  assert.deepEqual(
    buildModelMappingFromIntersection([
      'gpt-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'not-a-real-claude',
    ]),
    {
      'claude-sonnet-4-6': 'claude-sonnet-4-6',
      'claude-opus-4-8': 'claude-opus-4-8',
    }
  );
});

test('buildAnthropicAccountPayload uses requested name format and Sub2API Anthropic fields', () => {
  const payload = buildAnthropicAccountPayload(
    {
      site: 'cun.ai',
      baseUrl: 'https://www.cun.ai',
      apiKey: 'sk-test',
      userId: '9225',
    },
    {
      source: 'fresh-registration',
      email: 'amanda.tang@nsnzd.com',
      username: 'nsnzd-laylazhang124548',
    },
    {
      timestamp: '20260704194410',
      suffix: 'wzs712xqe8',
      groupIds: [1],
      upstreamModels: ['claude-sonnet-4-6', 'gpt-5'],
    }
  );

  assert.equal(payload.name, 'register-cun-anthropic-default-gh-20260704194410-wzs712xqe8');
  assert.equal(payload.platform, 'anthropic');
  assert.equal(payload.type, 'apikey');
  assert.equal(payload.concurrency, 1);
  assert.equal(payload.priority, 1);
  assert.deepEqual(payload.group_ids, [1]);
  assert.equal(payload.credentials.base_url, 'https://www.cun.ai');
  assert.equal(payload.credentials.api_key, 'sk-test');
  assert.deepEqual(payload.credentials.model_mapping, {
    'claude-sonnet-4-6': 'claude-sonnet-4-6',
  });
});
