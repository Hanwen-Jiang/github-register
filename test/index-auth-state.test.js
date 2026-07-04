const test = require('node:test');
const assert = require('node:assert/strict');
const { isGithubLoggedInUrl } = require('../index');

test('isGithubLoggedInUrl does not treat account_verifications as logged in', () => {
  assert.equal(isGithubLoggedInUrl('https://github.com/account_verifications'), false);
  assert.equal(isGithubLoggedInUrl('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard'), false);
  assert.equal(isGithubLoggedInUrl('https://github.com/dashboard'), true);
  assert.equal(isGithubLoggedInUrl('https://github.com/'), true);
});
