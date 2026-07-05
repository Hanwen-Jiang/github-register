'use strict';

function generateProxyPool({ count = 100, password = 'asdf1476', host = 'as.rrp.bestgo.work', port = 10000, userPrefix = 'jhw', pad = 3 } = {}) {
  const pool = [];
  for (let i = 1; i <= count; i += 1) {
    const idx = String(i).padStart(pad, '0');
    pool.push(`socks5://${userPrefix}${idx}-zone-custom:${password}@${host}:${port}`);
  }
  return pool;
}

module.exports = { generateProxyPool };
