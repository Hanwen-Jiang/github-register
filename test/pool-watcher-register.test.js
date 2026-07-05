const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { runOneRegistration } = require('../lib/pool-watcher');

function fakeSpawn(exitCode, capture) {
  return (command, args, opts) => {
    capture.command = command;
    capture.args = args;
    capture.proxy = opts.env.PROXY;
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', exitCode, null));
    return child;
  };
}

test('runOneRegistration passes PROXY and resolves true on exit 0', async () => {
  const capture = {};
  const ok = await runOneRegistration({
    proxy: 'socks5://p:1@h:10000',
    env: { FOO: 'bar' },
    spawnImpl: fakeSpawn(0, capture),
  });
  assert.equal(ok, true);
  assert.match(capture.args.join(' '), /register-upload-api-nsnzd\.js/);
  assert.equal(capture.proxy, 'socks5://p:1@h:10000');
});

test('runOneRegistration resolves false on non-zero exit', async () => {
  const ok = await runOneRegistration({ proxy: 'x', env: {}, spawnImpl: fakeSpawn(1, {}) });
  assert.equal(ok, false);
});

test('runOneRegistration resolves false on spawn error', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  const ok = await runOneRegistration({ proxy: 'x', env: {}, spawnImpl });
  assert.equal(ok, false);
});
