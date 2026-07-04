const net = require('net');

class SocketReader {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.waiters = [];
        this.error = null;
        socket.on('data', chunk => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this._drain();
        });
        socket.on('error', err => {
            this.error = err;
            this._drain();
        });
        socket.on('close', () => {
            if (!this.error) this.error = new Error('socket_closed');
            this._drain();
        });
    }

    read(n, timeoutMs = 15000) {
        if (this.buffer.length >= n) {
            const out = this.buffer.slice(0, n);
            this.buffer = this.buffer.slice(n);
            return Promise.resolve(out);
        }
        if (this.error) return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(w => w.resolve !== resolve);
                reject(new Error(`read_timeout_${n}`));
            }, timeoutMs);
            this.waiters.push({ n, resolve, reject, timer });
            this._drain();
        });
    }

    _drain() {
        for (const waiter of [...this.waiters]) {
            if (this.error) {
                clearTimeout(waiter.timer);
                this.waiters = this.waiters.filter(w => w !== waiter);
                waiter.reject(this.error);
            } else if (this.buffer.length >= waiter.n) {
                clearTimeout(waiter.timer);
                const out = this.buffer.slice(0, waiter.n);
                this.buffer = this.buffer.slice(waiter.n);
                this.waiters = this.waiters.filter(w => w !== waiter);
                waiter.resolve(out);
            }
        }
    }
}

function parseTargetFromRequest(head, reader) {
    return (async () => {
        if (head[0] !== 0x05 || head[1] !== 0x01) throw new Error('unsupported_socks_request');
        const atyp = head[3];
        let addrBuf;
        let host;
        if (atyp === 0x01) {
            addrBuf = await reader.read(4);
            host = Array.from(addrBuf).join('.');
        } else if (atyp === 0x03) {
            const lenBuf = await reader.read(1);
            const len = lenBuf[0];
            const nameBuf = await reader.read(len);
            addrBuf = Buffer.concat([lenBuf, nameBuf]);
            host = nameBuf.toString('utf8');
        } else if (atyp === 0x04) {
            addrBuf = await reader.read(16);
            host = addrBuf.toString('hex').match(/.{1,4}/g).join(':');
        } else {
            throw new Error(`unsupported_atyp_${atyp}`);
        }
        const portBuf = await reader.read(2);
        const port = portBuf.readUInt16BE(0);
        return { atyp, addrBuf, portBuf, host, port };
    })();
}

function socksReply(code) {
    return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

async function connectUpstream(upstream, target) {
    const upstreamSocket = net.connect(upstream.port, upstream.hostname);
    await new Promise((resolve, reject) => {
        upstreamSocket.once('connect', resolve);
        upstreamSocket.once('error', reject);
        setTimeout(() => reject(new Error('upstream_connect_timeout')), 15000).unref?.();
    });
    const reader = new SocketReader(upstreamSocket);

    // Offer no-auth and username/password; residential SOCKS usually selects username/password.
    upstreamSocket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    const method = await reader.read(2);
    if (method[0] !== 0x05) throw new Error('upstream_bad_greeting');
    if (method[1] === 0x02) {
        const username = Buffer.from(decodeURIComponent(upstream.username || ''), 'utf8');
        const password = Buffer.from(decodeURIComponent(upstream.password || ''), 'utf8');
        if (username.length > 255 || password.length > 255) throw new Error('upstream_auth_too_long');
        upstreamSocket.write(Buffer.concat([
            Buffer.from([0x01, username.length]), username,
            Buffer.from([password.length]), password,
        ]));
        const auth = await reader.read(2);
        if (auth[1] !== 0x00) throw new Error(`upstream_auth_failed_${auth[1]}`);
    } else if (method[1] !== 0x00) {
        throw new Error(`upstream_no_supported_auth_${method[1]}`);
    }

    upstreamSocket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, target.atyp]),
        target.addrBuf,
        target.portBuf,
    ]));
    const respHead = await reader.read(4);
    if (respHead[0] !== 0x05 || respHead[1] !== 0x00) {
        throw new Error(`upstream_connect_failed_${respHead[1]}`);
    }
    const bindAtyp = respHead[3];
    if (bindAtyp === 0x01) await reader.read(4);
    else if (bindAtyp === 0x03) { const l = await reader.read(1); await reader.read(l[0]); }
    else if (bindAtyp === 0x04) await reader.read(16);
    await reader.read(2);
    return upstreamSocket;
}

async function handleClient(client, upstream) {
    const reader = new SocketReader(client);
    try {
        const greeting = await reader.read(2);
        if (greeting[0] !== 0x05) throw new Error('not_socks5');
        await reader.read(greeting[1]);
        client.write(Buffer.from([0x05, 0x00]));

        const head = await reader.read(4);
        const target = await parseTargetFromRequest(head, reader);
        const upstreamSocket = await connectUpstream(upstream, target);
        client.write(socksReply(0x00));

        upstreamSocket.pipe(client);
        client.pipe(upstreamSocket);
        upstreamSocket.on('error', () => client.destroy());
        client.on('error', () => upstreamSocket.destroy());
    } catch (err) {
        try { client.write(socksReply(0x01)); } catch (_) {}
        client.destroy();
    }
}

function startAuthSocksBridge(upstreamUrl) {
    const u = new URL(upstreamUrl);
    if (u.protocol !== 'socks5:') throw new Error(`unsupported_upstream_proxy_${u.protocol}`);
    const upstream = {
        hostname: u.hostname,
        port: parseInt(u.port || '1080', 10),
        username: u.username || '',
        password: u.password || '',
    };
    const server = net.createServer(client => handleClient(client, upstream));
    server.on('error', err => console.error(`[ProxyBridge] server error: ${err.message}`));
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                url: `socks5://127.0.0.1:${addr.port}`,
                port: addr.port,
                close: () => new Promise(res => server.close(() => res())),
            });
        });
        server.once('error', reject);
    });
}

module.exports = { startAuthSocksBridge };
