const test = require('node:test');
const assert = require('node:assert/strict');
const { humanTypeOTP } = require('../human');

test('humanTypeOTP uses one fast page evaluation instead of slow per-digit typing', async () => {
  const calls = [];
  const page = {
    waitForSelector: async (selector, opts) => {
      calls.push(['waitForSelector', selector, opts.timeout]);
    },
    evaluate: async (_fn, code) => {
      calls.push(['evaluate', code]);
      return true;
    },
    locator: () => {
      throw new Error('slow per-digit locator path should not be used when fast fill succeeds');
    },
  };

  await humanTypeOTP(page, '12345678');

  assert.deepEqual(calls, [
    ['waitForSelector', '#launch-code-0', 10000],
    ['evaluate', '12345678'],
  ]);
});
