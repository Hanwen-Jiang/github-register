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
  normalizeResultKeys,
  resolveApiNsnzdProxy,
  resolveDefaultGroupId,
  resolveUploadGroup,
  resolveModelProxy,
  retryAsync,
  siteSlug,
  uploadAccounts,
  apiNsnzdGet,
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

test('normalizeResultKeys flattens legacy per-site nested keys', () => {
  const keys = normalizeResultKeys({
    keys: [
      {
        site: 'cun.ai',
        baseUrl: 'https://www.cun.ai',
        userId: '9553',
        keys: [{ apiKey: 'sk-cun', profile: 'dynamic-cheap' }],
      },
      {
        site: 'a6api',
        baseUrl: 'https://a6api.com',
        userId: '3114',
        keys: [{ apiKey: 'sk-a6', profile: 'dynamic-fast' }],
      },
    ],
  });

  assert.deepEqual(keys, [
    { site: 'cun.ai', baseUrl: 'https://www.cun.ai', userId: '9553', apiKey: 'sk-cun', profile: 'dynamic-cheap' },
    { site: 'a6api', baseUrl: 'https://a6api.com', userId: '3114', apiKey: 'sk-a6', profile: 'dynamic-fast' },
  ]);
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

test('resolveModelProxy ignores registration PROXY by default for upload model probing', () => {
  assert.equal(
    resolveModelProxy({}, { PROXY: 'socks5://registration-proxy:10000' }),
    ''
  );
});

test('resolveModelProxy only uses explicit upload/model proxy settings', () => {
  assert.equal(
    resolveModelProxy({}, {
      PROXY: 'socks5://registration-proxy:10000',
      UPLOAD_MODEL_PROXY: 'socks5://upload-model-proxy:10000',
    }),
    'socks5://upload-model-proxy:10000'
  );
  assert.equal(
    resolveModelProxy({ modelProxy: 'socks5://explicit-model-proxy:10000' }, {
      UPLOAD_MODEL_PROXY: 'socks5://upload-model-proxy:10000',
    }),
    'socks5://explicit-model-proxy:10000'
  );
  assert.equal(
    resolveModelProxy({ proxy: 'socks5://explicit-legacy-proxy:10000' }, {
      UPLOAD_MODEL_PROXY: 'socks5://upload-model-proxy:10000',
    }),
    'socks5://explicit-legacy-proxy:10000'
  );
});

test('resolveApiNsnzdProxy uses explicit API proxy before generic proxy', () => {
  assert.equal(
    resolveApiNsnzdProxy({}, { API_NSNZD_PROXY: 'socks5://127.0.0.1:2080', PROXY: 'socks5://other:10000' }),
    'socks5://127.0.0.1:2080'
  );
  assert.equal(
    resolveApiNsnzdProxy({}, { API_NSNZD_PROXY_MODE: 'registration-proxy', PROXY: 'socks5://127.0.0.1:2080' }),
    'socks5://127.0.0.1:2080'
  );
  assert.equal(resolveApiNsnzdProxy({}, { PROXY: 'socks5://127.0.0.1:2080' }), '');
});

test('uploadAccounts sends api.nsnzd.com batch upload through explicit proxy transport', async () => {
  const calls = [];
  const resp = await uploadAccounts([{ name: 'acct' }], {
    adminKey: 'admin-test',
    apiProxy: 'socks5://127.0.0.1:2080',
    deps: {
      initSocks: (proxy) => calls.push(['init', proxy]),
      socksRequest: async (url, opts) => {
        calls.push(['socks', url, opts.method, opts.headers['x-api-key'], opts.body]);
        return { status: 200, text: () => '{"code":0,"data":{"success":true}}' };
      },
      fetchImpl: async () => { throw new Error('fetch should not be used'); },
    },
  });

  assert.deepEqual(resp, { success: true });
  assert.equal(calls[0][0], 'init');
  assert.equal(calls[0][1], 'socks5://127.0.0.1:2080');
  assert.equal(calls[1][0], 'socks');
  assert.equal(calls[1][1], 'https://api.nsnzd.com/api/v1/admin/accounts/batch');
  assert.equal(calls[1][2], 'POST');
  assert.equal(calls[1][3], 'admin-test');
  assert.match(calls[1][4], /"accounts"/);
});

test('apiNsnzdGet sends admin GET through explicit proxy transport', async () => {
  const calls = [];
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', {
    adminKey: 'admin-test',
    apiProxy: 'socks5://127.0.0.1:2080',
    deps: {
      initSocks: (proxy) => calls.push(['init', proxy]),
      socksRequest: async (url, opts) => {
        calls.push(['socks', url, opts.method || 'GET', opts.headers['x-api-key']]);
        return { status: 200, text: () => '{"code":0,"data":[{"id":1,"name":"default"}]}' };
      },
      fetchImpl: async () => { throw new Error('fetch should not be used'); },
    },
  });

  assert.deepEqual(groups, [{ id: 1, name: 'default' }]);
  assert.deepEqual(calls, [
    ['init', 'socks5://127.0.0.1:2080'],
    ['socks', 'https://api.nsnzd.com/api/v1/admin/groups/all?include_inactive=true', 'GET', 'admin-test'],
  ]);
});

test('apiNsnzdGet tolerates chunk terminator left by SOCKS transport', async () => {
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', {
    adminKey: 'admin-test',
    requestImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":0,"message":"success","data":[{"id":2,"name":"OpenAI 官方渠道","status":"active"}]}\r\n0\r\n\r\n',
    }),
  });

  assert.deepEqual(groups, [{ id: 2, name: 'OpenAI 官方渠道', status: 'active' }]);
});

test('resolveDefaultGroupId can use an explicit env group id', async () => {
  const id = await resolveDefaultGroupId({
    adminKey: 'admin-test',
    env: { UPLOAD_GROUP_ID: '2' },
    requestImpl: async () => { throw new Error('groups endpoint should not be called'); },
  });

  assert.equal(id, 2);
});

test('resolveDefaultGroupId falls back to the first active group when default is absent', async () => {
  const id = await resolveDefaultGroupId({
    adminKey: 'admin-test',
    requestImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: [
        { id: 2, name: 'OpenAI 官方渠道', status: 'inactive' },
        { id: 3, name: 'Claude 渠道', status: 'active' },
      ] }),
    }),
  });

  assert.equal(id, 3);
});

test('resolveUploadGroup fetches groups and asks which group to upload into', async () => {
  const calls = [];
  const promptCalls = [];

  const group = await resolveUploadGroup({
    adminKey: 'admin-test',
    cache: false,
    env: {},
    requestImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: [
          { id: 1, name: 'default', status: 'active' },
          { id: 9, name: 'Claude 渠道', status: 'active' },
        ] }),
      };
    },
    promptFn: async (ctx) => {
      promptCalls.push(ctx);
      return '9';
    },
  });

  assert.deepEqual(group, {
    id: 9,
    name: 'Claude 渠道',
    group: { id: 9, name: 'Claude 渠道', status: 'active' },
  });
  assert.deepEqual(calls, ['https://api.nsnzd.com/api/v1/admin/groups/all?include_inactive=true']);
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].defaultGroup.id, 1);
  assert.deepEqual(promptCalls[0].groups.map(g => g.id), [1, 9]);
});

test('apiNsnzdGet parses nested JSON strings returned by proxy transport', async () => {
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', {
    adminKey: 'admin-test',
    requestImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify('{"code":0,"message":"success","data":[{"id":4,"name":"default","status":"active"}]}'),
    }),
  });

  assert.deepEqual(groups, [{ id: 4, name: 'default', status: 'active' }]);
});

test('apiNsnzdGet parses nested JSON strings with chunk terminator returned by proxy transport', async () => {
  const groups = await apiNsnzdGet('/api/v1/admin/groups/all?include_inactive=true', {
    adminKey: 'admin-test',
    requestImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify('{"code":0,"message":"success","data":[{"id":5,"name":"default","status":"active"}]}\r\n0\r\n\r\n'),
    }),
  });

  assert.deepEqual(groups, [{ id: 5, name: 'default', status: 'active' }]);
});

test('apiNsnzdGet tolerates partial chunk terminator left by SOCKS transport', async () => {
  const proxies = await apiNsnzdGet('/api/v1/admin/proxies/all?include_inactive=true', {
    adminKey: 'admin-test',
    requestImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":0,"message":"success","data":[{"id":2,"name":"default","status":"active"}]}\r\n0\r',
    }),
  });

  assert.deepEqual(proxies, [{ id: 2, name: 'default', status: 'active' }]);
});
