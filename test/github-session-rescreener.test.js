const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-rescreener-'));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

test('discoverSessionFiles includes session stores, imports, backups, and cookie archives', () => {
  const rootDir = makeRoot();
  writeJsonl(path.join(rootDir, 'data', 'sessions.jsonl'), [{ email: 'main@example.com' }]);
  writeJsonl(path.join(rootDir, 'data', 'sessions.win.usable.jsonl'), [{ email: 'usable@example.com' }]);
  writeJsonl(path.join(rootDir, 'data', 'remote-imports', 'remote.jsonl'), [{ email: 'remote@example.com' }]);
  writeJsonl(path.join(rootDir, 'data', 'backups', 'backup.jsonl'), [{ email: 'backup@example.com' }]);
  fs.mkdirSync(path.join(rootDir, 'data', 'github-cookies'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'data', 'github-cookies.json'), JSON.stringify({ email: 'latest@example.com', cookies: [] }));
  fs.writeFileSync(path.join(rootDir, 'data', 'github-cookies', 'one.json'), JSON.stringify({ email: 'cookie@example.com', storage_state: { cookies: [] } }));
  fs.writeFileSync(path.join(rootDir, 'data', 'github-session-live-check.json'), JSON.stringify({ ok: [], bad: [] }));
  writeJsonl(path.join(rootDir, 'data', 'sessions.merged.jsonl'), [{ email: 'derived@example.com' }]);
  writeJsonl(path.join(rootDir, 'data', 'sessions.rescreened.usable.jsonl'), [{ email: 'derived-usable@example.com' }]);
  writeJsonl(path.join(rootDir, 'data', 'sessions.rescreened.rejected.jsonl'), [{ email: 'derived-rejected@example.com' }]);
  fs.writeFileSync(path.join(rootDir, 'data', 'results.jsonl'), '{}\n');

  const { discoverSessionFiles } = require('../lib/github-session-rescreener');
  const relative = discoverSessionFiles(rootDir).map(file => path.relative(rootDir, file)).sort();

  assert.deepEqual(relative, [
    'data/backups/backup.jsonl',
    'data/github-cookies.json',
    'data/github-cookies/one.json',
    'data/remote-imports/remote.jsonl',
    'data/sessions.jsonl',
    'data/sessions.win.usable.jsonl',
  ]);
});

test('readSessionArtifacts normalizes JSONL, arrays, session containers, and cookie archives', () => {
  const rootDir = makeRoot();
  const jsonl = path.join(rootDir, 'data', 'sessions.jsonl');
  const array = path.join(rootDir, 'data', 'remote-imports', 'array.json');
  const container = path.join(rootDir, 'data', 'backups', 'container.json');
  const cookie = path.join(rootDir, 'data', 'github-cookies', 'cookie.json');
  writeJsonl(jsonl, [{ email: 'a@example.com', username: 'a' }, { email: 'b@example.com', username: 'b' }]);
  fs.mkdirSync(path.dirname(array), { recursive: true });
  fs.writeFileSync(array, JSON.stringify([{ email: 'c@example.com', username: 'c' }]));
  fs.mkdirSync(path.dirname(container), { recursive: true });
  fs.writeFileSync(container, JSON.stringify({ sessions: [{ email: 'd@example.com', username: 'd' }] }));
  fs.mkdirSync(path.dirname(cookie), { recursive: true });
  fs.writeFileSync(cookie, JSON.stringify({
    email: 'e@example.com',
    username: 'e',
    cookies: [{ name: 'user_session', value: 'secret', domain: '.github.com', path: '/' }],
  }));

  const { readSessionArtifacts } = require('../lib/github-session-rescreener');
  const records = readSessionArtifacts([jsonl, array, container, cookie]);

  assert.deepEqual(records.map(record => record.email).sort(), [
    'a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com',
  ]);
  const cookieRecord = records.find(record => record.email === 'e@example.com');
  assert.equal(cookieRecord.storage_state.cookies[0].name, 'user_session');
  assert.equal(cookieRecord.source_file, cookie);
});

test('mergeSessionRecords keeps all variants and orders the freshest first', () => {
  const { mergeSessionRecords } = require('../lib/github-session-rescreener');
  const merged = mergeSessionRecords([
    { email: 'Same@Example.com', username: 'same', created_at: '2026-07-01T00:00:00Z', storage_state: { cookies: [{ value: 'old' }] } },
    { email: 'same@example.com', username: 'same', refreshed_at: '2026-07-10T00:00:00Z', storage_state: { cookies: [{ value: 'fresh' }] } },
    { email: '', username: 'username-only', created_at: '2026-07-05T00:00:00Z', storage_state: { cookies: [] } },
  ]);

  assert.equal(merged.length, 2);
  const same = merged.find(identity => identity.key === 'email:same@example.com');
  assert.equal(same.variants.length, 2);
  assert.equal(same.variants[0].storage_state.cookies[0].value, 'fresh');
  assert.equal(same.email, 'same@example.com');
  assert.equal(merged.find(identity => identity.key === 'username:username-only').username, 'username-only');
});

test('parseGithubUserSearch requires an exact login in payload results', () => {
  const { parseGithubUserSearch } = require('../lib/github-session-rescreener');

  assert.equal(parseGithubUserSearch({ payload: { results: [{ login: 'Alive-User' }] } }, 'alive-user'), true);
  assert.equal(parseGithubUserSearch({ payload: { results: [{ login: 'alive-user-extra' }] } }, 'alive-user'), false);
  assert.equal(parseGithubUserSearch({ payload: { results: [] } }, 'alive-user'), false);
  assert.equal(parseGithubUserSearch(null, 'alive-user'), false);
});

test('screenIdentity rejects a missing GitHub user without checking cookies', async () => {
  const { screenIdentity } = require('../lib/github-session-rescreener');
  let verifyCalls = 0;
  const identity = {
    key: 'email:gone@example.com',
    email: 'gone@example.com',
    username: 'gone-user',
    variants: [{ email: 'gone@example.com', username: 'gone-user' }],
  };

  const result = await screenIdentity(identity, {
    searchUser: async () => ({ payload: { results: [] } }),
    verifySession: async () => { verifyCalls += 1; return { ok: true }; },
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'github_user_missing');
  assert.equal(verifyCalls, 0);
});

test('screenIdentity does not classify a GitHub search failure as a missing user', async () => {
  const { screenIdentity } = require('../lib/github-session-rescreener');
  const identity = {
    key: 'email:unknown@example.com',
    email: 'unknown@example.com',
    username: 'unknown-user',
    variants: [{ email: 'unknown@example.com', username: 'unknown-user' }],
  };

  await assert.rejects(() => screenIdentity(identity, {
    searchUser: async () => { throw new Error('rate limited'); },
    verifySession: async () => ({ ok: true }),
  }), /github search failed.*rate limited/i);
});

test('screenIdentity keeps a later live cookie variant before attempting refresh', async () => {
  const { screenIdentity } = require('../lib/github-session-rescreener');
  const calls = [];
  const variants = [
    { email: 'a@example.com', username: 'alive-user', version: 'new', password: 'pw' },
    { email: 'a@example.com', username: 'alive-user', version: 'old', password: 'pw' },
  ];

  const result = await screenIdentity({ key: 'email:a@example.com', email: 'a@example.com', username: 'alive-user', variants }, {
    searchUser: async () => ({ payload: { results: [{ login: 'alive-user' }] } }),
    verifySession: async (session) => {
      calls.push(`verify:${session.version}`);
      return { ok: session.version === 'old', reason: 'session_expired' };
    },
    refreshSession: async () => { calls.push('refresh'); return {}; },
  });

  assert.deepEqual(calls, ['verify:new', 'verify:old']);
  assert.equal(result.status, 'usable');
  assert.equal(result.session.version, 'old');
  assert.equal(result.refreshed, false);
});

test('screenIdentity refreshes once after all cookie variants expire and verifies the result', async () => {
  const { screenIdentity } = require('../lib/github-session-rescreener');
  const calls = [];
  const variants = [
    { email: 'a@example.com', username: 'alive-user', version: 'new', password: 'pw' },
    { email: 'a@example.com', username: 'alive-user', version: 'old', password: 'pw' },
  ];

  const result = await screenIdentity({ key: 'email:a@example.com', email: 'a@example.com', username: 'alive-user', variants }, {
    searchUser: async () => ({ payload: { results: [{ login: 'alive-user' }] } }),
    verifySession: async (session) => {
      calls.push(`verify:${session.version}`);
      return { ok: session.version === 'refreshed', reason: 'session_expired' };
    },
    refreshSession: async (session) => {
      calls.push(`refresh:${session.version}`);
      return { storageState: { cookies: [{ name: 'user_session', value: 'new' }] }, refreshedAt: '2026-07-11T00:00:00Z' };
    },
  });

  assert.deepEqual(calls, ['verify:new', 'verify:old', 'refresh:new', 'verify:refreshed']);
  assert.equal(result.status, 'usable');
  assert.equal(result.refreshed, true);
  assert.equal(result.session.storage_state.cookies[0].value, 'new');
  assert.equal(result.session.status, 'active');
});

test('screenIdentity does not refresh a suspended session', async () => {
  const { screenIdentity } = require('../lib/github-session-rescreener');
  let refreshCalls = 0;
  const variant = { email: 'a@example.com', username: 'alive-user', password: 'pw' };

  const result = await screenIdentity({ key: 'email:a@example.com', email: 'a@example.com', username: 'alive-user', variants: [variant] }, {
    searchUser: async () => ({ payload: { results: [{ login: 'alive-user' }] } }),
    verifySession: async () => ({ ok: false, reason: 'github_suspended' }),
    refreshSession: async () => { refreshCalls += 1; return {}; },
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'github_suspended');
  assert.equal(refreshCalls, 0);
});

test('rescreenSessions separates usable and rejected identities with progress', async () => {
  const { rescreenSessions } = require('../lib/github-session-rescreener');
  const identities = [
    { key: 'email:a@example.com', email: 'a@example.com', username: 'alive', variants: [{ email: 'a@example.com', username: 'alive' }] },
    { key: 'email:b@example.com', email: 'b@example.com', username: 'gone', variants: [{ email: 'b@example.com', username: 'gone' }] },
  ];
  const progress = [];

  const result = await rescreenSessions({
    identities,
    searchUser: async username => ({ payload: { results: username === 'alive' ? [{ login: 'alive' }] : [] } }),
    verifySession: async () => ({ ok: true }),
    onProgress: update => progress.push(update),
  });

  assert.equal(result.usable.length, 1);
  assert.equal(result.usable[0].username, 'alive');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'github_user_missing');
  assert.deepEqual(result.report, {
    total: 2,
    usable: 1,
    rejected: 1,
    refreshed: 0,
    reasons: { github_user_missing: 1 },
  });
  assert.deepEqual(progress.map(item => item.checked), [1, 2]);
});

test('writeRescreenOutputs atomically writes merged, usable, rejected, and report files', () => {
  const rootDir = makeRoot();
  const outputDir = path.join(rootDir, 'data');
  const { writeRescreenOutputs } = require('../lib/github-session-rescreener');
  const result = {
    mergedRecords: [{ email: 'a@example.com', username: 'alive', storage_state: { cookies: [] } }],
    usable: [{ email: 'a@example.com', username: 'alive', storage_state: { cookies: [] } }],
    rejected: [{ email: 'b@example.com', username: 'gone', reason: 'github_user_missing' }],
    report: { total: 2, usable: 1, rejected: 1, refreshed: 0, reasons: { github_user_missing: 1 } },
  };

  const files = writeRescreenOutputs(result, { outputDir });

  assert.deepEqual(JSON.parse(fs.readFileSync(files.reportFile, 'utf8')), result.report);
  assert.equal(JSON.parse(fs.readFileSync(files.usableFile, 'utf8').trim()).email, 'a@example.com');
  assert.equal(JSON.parse(fs.readFileSync(files.rejectedFile, 'utf8').trim()).reason, 'github_user_missing');
  assert.equal(JSON.parse(fs.readFileSync(files.mergedFile, 'utf8').trim()).username, 'alive');
  assert.equal(fs.readdirSync(outputDir).some(name => name.includes('.tmp-')), false);
});

test('rescreen CLI parses refresh and output options', () => {
  const { parseArgs } = require('../rescreen-github-sessions');

  assert.deepEqual(parseArgs([]), {
    refreshExpired: true,
    outputDir: '',
    limit: Infinity,
    searchDelayMs: 100,
    searchBatchSize: 2,
  });
  assert.deepEqual(parseArgs(['--no-refresh', '--output-dir', '/tmp/out', '--limit', '25', '--search-delay-ms', '250', '--search-batch-size', '3']), {
    refreshExpired: false,
    outputDir: '/tmp/out',
    limit: 25,
    searchDelayMs: 250,
    searchBatchSize: 3,
  });
});

test('requestGithubUserSearch retries 429 responses using Retry-After', async () => {
  const { requestGithubUserSearch } = require('../rescreen-github-sessions');
  const waits = [];
  const retries = [];
  let calls = 0;
  const client = {
    async get() {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          headers: { 'retry-after': '2' },
          text: () => 'rate limited',
          json: () => null,
        };
      }
      return {
        status: 200,
        headers: {},
        text: () => '',
        json: () => ({ payload: { results: [{ login: 'alive-user' }] } }),
      };
    },
  };

  const json = await requestGithubUserSearch(client, 'alive-user', {
    retries: 2,
    sleep: async ms => waits.push(ms),
    onRetry: event => retries.push(event),
  });

  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(retries, [{ username: 'alive-user', attempt: 1, waitMs: 2000, status: 429 }]);
  assert.equal(json.payload.results[0].login, 'alive-user');
});

test('searchGithubUsersInBatches uses OR queries and keeps exact result logins', async () => {
  const { searchGithubUsersInBatches } = require('../rescreen-github-sessions');
  const queries = [];
  const waits = [];
  const existing = new Set(['user-a', 'user-c', 'user-e']);

  const alive = await searchGithubUsersInBatches(
    ['user-a', 'user-b', 'user-c', 'user-d', 'user-e'],
    {
      batchSize: 2,
      delayMs: 50,
      sleep: async ms => waits.push(ms),
      requestSearch: async query => {
        queries.push(query);
        return {
          payload: {
            results: query.split(' OR ').filter(login => existing.has(login)).map(login => ({ login })),
          },
        };
      },
    },
  );

  assert.deepEqual(queries, ['user-a OR user-b', 'user-c OR user-d', 'user-e']);
  assert.deepEqual([...alive].sort(), ['user-a', 'user-c', 'user-e']);
  assert.deepEqual(waits, [50, 50]);
});

test('findSearchClient prioritizes sessions.win_gw_lou.usable records', async () => {
  const { findSearchClient } = require('../rescreen-github-sessions');
  const attempted = [];
  const records = [
    { username: 'backup', storage_state: { cookies: [{ name: 'user_session' }] }, source_file: '/repo/data/backups/old.jsonl' },
    { username: 'usable', storage_state: { cookies: [{ name: 'user_session' }] }, source_file: '/repo/data/sessions.win_gw_lou.usable.jsonl' },
  ];

  const client = await findSearchClient(records, {
    probeUsername: 'known-alive',
    clientFactory: session => ({ username: session.username }),
    requestSearch: async candidate => {
      attempted.push(candidate.username);
      return { payload: { results: candidate.username === 'usable' ? [{ login: 'known-alive' }] : [] } };
    },
  });

  assert.equal(client.username, 'usable');
  assert.deepEqual(attempted, ['usable']);
});
