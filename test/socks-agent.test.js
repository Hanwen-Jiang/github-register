const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeChunks } = require('../socks-agent');

test('decodeChunks decodes a complete HTTP chunked body', () => {
  const encoded = '33\r\n{"data":"ZFhPz1CmtW2o","message":"","success":true}\r\n0\r\n\r\n';
  assert.equal(decodeChunks(encoded), '{"data":"ZFhPz1CmtW2o","message":"","success":true}');
});

const http = require('node:http');
const net = require('node:net');

function startTinySocksProxy() {
  const server = net.createServer((client) => {
    let stage = 0;
    let target = null;
    let upstream = null;
    client.once('data', () => {
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', (req) => {
        const atyp = req[3];
        let offset = 4;
        if (atyp !== 0x01) throw new Error('test proxy only supports ipv4');
        const host = Array.from(req.slice(offset, offset + 4)).join('.');
        offset += 4;
        const port = req.readUInt16BE(offset);
        upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
      });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('socksRequest returns chunked response body from a local HTTP server', async () => {
  const { init, socksRequest } = require('../socks-agent');
  const httpServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('transfer-encoding', 'chunked');
    res.write('{"data":"');
    setTimeout(() => {
      res.write('STATE');
      res.end('","success":true}');
    }, 10);
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const proxy = await startTinySocksProxy();
  try {
    init(`socks5://127.0.0.1:${proxy.address().port}`);
    const resp = await socksRequest(`http://127.0.0.1:${httpServer.address().port}/api/oauth/state?aff=`, { headers: {} });
    assert.equal(resp.status, 200);
    assert.equal(resp.text(), '{"data":"STATE","success":true}');
    assert.deepEqual(resp.json(), { data: 'STATE', success: true });
  } finally {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => httpServer.close(resolve));
  }
});
