const test = require('node:test');
const assert = require('node:assert/strict');
const { dismissGitHubCookieBanner } = require('../index');

function fakePage(visibleSelector) {
  const calls = [];
  return {
    calls,
    locator(selector) {
      const locator = {
        first() { return locator; },
        async isVisible() {
          calls.push(['isVisible', selector]);
          return selector === visibleSelector;
        },
        async click(opts) {
          calls.push(['click', selector, opts]);
        },
      };
      return locator;
    },
  };
}

test('dismissGitHubCookieBanner clicks visible Reject button', async () => {
  const page = fakePage('button:has-text("Reject")');
  const dismissed = await dismissGitHubCookieBanner(page, { delay: async () => {}, quiet: true });

  assert.equal(dismissed, true);
  assert.deepEqual(page.calls.filter(([type]) => type === 'click'), [
    ['click', 'button:has-text("Reject")', { force: true }],
  ]);
});
