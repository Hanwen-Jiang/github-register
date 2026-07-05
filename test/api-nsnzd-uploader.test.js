const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAnthropicAccountPayload,
  buildAnthropicAccountsWithLiveModels,
  buildAnthropicAccountsFromResult,
  buildModelMappingFromIntersection,
  fetchUpstreamModels,
  formatUtcTimestamp,
  normalizeAdminKey,
  retryAsync,
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

test('retryAsync retries transient failures before returning success', async () => {
  let attempts = 0;

  const value = await retryAsync(async () => {
    attempts++;
    if (attempts < 3) throw new Error(`temporary-${attempts}`);
    return 'ok';
  }, {
    retries: 2,
    delayMs: 0,
  });

  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});

test('buildAnthropicAccountsWithLiveModels tries another key from the same site after a model probe failure', async () => {
  const result = {
    username: 'nsnzd-probe-user',
    keys: [
      { site: 'cun.ai', baseUrl: 'https://www.cun.ai', apiKey: 'sk-first' },
      { site: 'cun.ai', baseUrl: 'https://www.cun.ai', apiKey: 'sk-second' },
    ],
  };
  const probed = [];

  const accounts = await buildAnthropicAccountsWithLiveModels(result, {
    groupIds: [1],
    fetchUpstreamModelsFn: async (key) => {
      probed.push(key.apiKey);
      if (key.apiKey === 'sk-first') throw new Error('key not ready');
      return ['claude-sonnet-4-6', 'gpt-5'];
    },
  });

  assert.deepEqual(probed, ['sk-first', 'sk-second']);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0].credentials.model_mapping, {
    'claude-sonnet-4-6': 'claude-sonnet-4-6',
  });
});

test('buildAnthropicAccountsFromResult assigns proxy ids round-robin when provided', () => {
  const result = {
    username: 'nsnzd-proxy-user',
    keys: [
      { site: 'cun.ai', baseUrl: 'https://www.cun.ai', apiKey: 'sk-1' },
      { site: 'cun.ai', baseUrl: 'https://www.cun.ai', apiKey: 'sk-2' },
      { site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-3' },
      { site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-4' },
    ],
  };

  const accounts = buildAnthropicAccountsFromResult(result, {
    upstreamModels: ['claude-sonnet-4-6'],
    proxyIds: [6, 7, 8],
  });

  assert.deepEqual(accounts.map(a => a.proxy_id), [6, 7, 8, 6]);
});

test('fetchUpstreamModels uses injected requestImpl (proxy path) and parses ids', async () => {
  const calls = [];
  const requestImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'claude-opus-4-8' }, { id: 'x' }] }) };
  };
  const ids = await fetchUpstreamModels(
    { apiKey: 'sk-test', baseUrl: 'https://a6api.com', site: 'a6api' },
    { requestImpl, retries: 0 }
  );
  assert.deepEqual(ids, ['claude-opus-4-8', 'x']);
  assert.match(calls[0].url, /\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
});
