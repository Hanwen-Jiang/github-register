// socks-agent.js — SOCKS5 tunnel for Node.js http.request
//
// 不依赖 Agent.createConnection（Node v26 已移除该 API）。
// 直接手动建 SOCKS5 隧道，然后在此 socket 上发 HTTP 请求。

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

// Decode HTTP chunked transfer encoding
function decodeChunks(data) {
    let result = '';
    let i = 0;
    while (i < data.length) {
        // Find chunk size line end
        let j = data.indexOf('\r\n', i);
        if (j < 0) break;
        const sizeHex = data.slice(i, j);
        const size = parseInt(sizeHex, 16);
        if (size === 0 || isNaN(size)) break; // last chunk
        i = j + 2;
        result += data.slice(i, i + size);
        i += size + 2; // skip \r\n after chunk data
    }
    return result;
}

// SOCKS5 handshake — 预解析 DNS，用 IPv4 connect（sandbox DNS blocked）
const dns = require('dns');

function socks5Handshake(proxyHost, proxyPort, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        // 用系统 DNS 先解析 IP
        dns.lookup(targetHost, { family: 4 }, (err, ip) => {
            if (err) return reject(new Error(`DNS ${targetHost}: ${err.message}`));

            const socket = net.connect(proxyPort, proxyHost);
            socket.once('error', reject);
            socket.once('connect', () => {
                // Greeting: no auth
                socket.write(Buffer.from([0x05, 0x01, 0x00]));
                socket.once('data', (data) => {
                    if (data[0] !== 0x05 || data[1] !== 0x00) {
                        socket.destroy();
                        return reject(new Error(`SOCKS5 greeting failed`));
                    }
                    // Connect request — IPv4 type
                    const parts = ip.split('.').map(Number);
                    const req = Buffer.alloc(10);
                    req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x01;
                    req[4] = parts[0]; req[5] = parts[1];
                    req[6] = parts[2]; req[7] = parts[3];
                    req.writeUInt16BE(targetPort, 8);
                    socket.write(req);

                    socket.once('data', (resp) => {
                        if (resp[1] !== 0x00) {
                            socket.destroy();
                            return reject(new Error(`SOCKS5 to ${targetHost}:${targetPort} failed: ${resp[1]}`));
                        }
                        resolve(socket);
                    });
                });
            });
        });
    });
}

// HTTP request through SOCKS5 tunnel
function socksRequest(urlStr, opts) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const isHttps = u.protocol === 'https:';
        const targetHost = u.hostname;
        const targetPort = u.port ? parseInt(u.port) : (isHttps ? 443 : 80);
        const proxyHost = PROXY_HOST;
        const proxyPort = PROXY_PORT;

        socks5Handshake(proxyHost, proxyPort, targetHost, targetPort)
            .then(socket => {
                // HTTPS: wrap in TLS
                const finalSocket = isHttps
                    ? tls.connect({ socket, servername: targetHost, rejectUnauthorized: false })
                    : socket;

                // Build raw HTTP request
                const path = u.pathname + u.search;
                const method = opts.method || 'GET';
                const headers = {
                    'Host': targetHost,
                    'Connection': 'close',
                    ...(opts.headers || {}),
                };
                if (opts.body) {
                    headers['Content-Length'] = Buffer.byteLength(opts.body);
                }

                const reqLines = [`${method} ${path} HTTP/1.1`];
                for (const [k, v] of Object.entries(headers)) {
                    reqLines.push(`${k}: ${v}`);
                }
                reqLines.push('', '');

                finalSocket.write(reqLines.join('\r\n'));
                if (opts.body) finalSocket.write(opts.body);

                // Parse response
                let buffer = '';
                let headerEnd = false;
                let respHeaders = {};
                let statusCode = 0;
                let headerStr = '';

                let contentLength = 0;
                let chunked = false;
                let bodyBytes = 0;

                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    const body = chunked ? decodeChunks(buffer) : buffer;
                    resolve({
                        status: statusCode,
                        headers: respHeaders,
                        text: () => body,
                        json: () => { try { return JSON.parse(body); } catch (_) { return null; } },
                    });
                };

                finalSocket.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    if (!headerEnd) {
                        buffer += text;
                        const idx = buffer.indexOf('\r\n\r\n');
                        if (idx < 0) return;

                        headerStr = buffer.slice(0, idx);
                        const remaining = buffer.slice(idx + 4);
                        buffer = '';

                        const lines = headerStr.split('\r\n');
                        const statusLine = lines[0];
                        statusCode = parseInt(statusLine.split(' ')[1]) || 0;

                        for (let i = 1; i < lines.length; i++) {
                            const col = lines[i].indexOf(':');
                            if (col > 0) {
                                const k = lines[i].slice(0, col).trim();
                                const v = lines[i].slice(col + 1).trim();
                                if (k.toLowerCase() === 'set-cookie' && respHeaders[k]) {
                                    respHeaders[k] = `${respHeaders[k]}, ${v}`;
                                } else {
                                    respHeaders[k] = v;
                                }
                                if (k.toLowerCase() === 'content-length') contentLength = parseInt(v) || 0;
                                if (k.toLowerCase() === 'transfer-encoding' && v.toLowerCase().includes('chunked')) chunked = true;
                            }
                        }
                        headerEnd = true;
                        if (remaining) {
                            buffer += remaining;
                            bodyBytes += Buffer.byteLength(remaining, 'utf8');
                        }
                        if (statusCode >= 300 && statusCode < 400) {
                            finalSocket.end();
                            return;
                        }
                    } else {
                        buffer += text;
                        bodyBytes += Buffer.byteLength(text, 'utf8');
                    }

                    if (headerEnd && chunked && buffer.includes('\r\n0\r\n')) {
                        finalSocket.end();
                    } else if (headerEnd && !chunked && contentLength > 0 && bodyBytes >= contentLength) {
                        finalSocket.end();
                    }
                });

                finalSocket.on('end', () => {
                    if (!headerEnd) {
                        if (!settled) {
                            settled = true;
                            resolve({ status: 0, headers: {}, text: () => '', json: () => null });
                        }
                    } else {
                        finish();
                    }
                });
                finalSocket.on('close', () => {
                    if (!headerEnd) {
                        if (!settled) {
                            settled = true;
                            resolve({ status: 0, headers: {}, text: () => '', json: () => null });
                        }
                    } else {
                        finish();
                    }
                });

                finalSocket.on('error', reject);
            })
            .catch(reject);
    });
}

let PROXY_HOST = '127.0.0.1';
let PROXY_PORT = 2080;

function init(proxyUrl) {
    const u = new URL(proxyUrl);
    PROXY_HOST = u.hostname;
    PROXY_PORT = parseInt(u.port) || 1080;
}

module.exports = { init, socksRequest, decodeChunks };
