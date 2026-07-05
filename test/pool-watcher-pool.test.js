const test = require('node:test');
const assert = require('node:assert/strict');
const { readUsablePool } = require('../lib/pool-watcher');

function fakeFetch(pages) {
  // pages: array of {items, pages} keyed by page number (1-based)
  return async (url) => {
    const m = url.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    const body = pages[page - 1];
    return { ok: true, status: 200, json: async () => ({ code: 0, data: body }) };
  };
}

test('readUsablePool counts only schedulable anthropic-active across pages', async () => {
  const p1 = {
    pages: 2,
    items: [
      { platform: 'anthropic', status: 'active', schedulable: true },
      { platform: 'anthropic', status: 'active', schedulable: false }, // excluded
      { platform: 'openai', status: 'active', schedulable: true },      // excluded
    ],
  };
  const p2 = {
    pages: 2,
    items: [
      { platform: 'anthropic', status: 'error', schedulable: true },    // excluded
      { platform: 'anthropic', status: 'active', schedulable: true },   // counted
    ],
  };
  const n = await readUsablePool({ adminKey: 'k', fetchImpl: fakeFetch([p1, p2]) });
  assert.equal(n, 2);
});

test('readUsablePool throws on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => readUsablePool({ adminKey: 'k', fetchImpl }), /pool read failed/i);
});
