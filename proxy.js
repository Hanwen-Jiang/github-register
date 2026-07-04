// proxy.js — 代理节点管理器
//
// 从 ipproxy.yaml 解析可用节点 → sing-box 转本地 SOCKS5 → 连通性测试
// 支持 IP 代理池轮换，供 index.js Playwright 使用
//
// 用法：
//   node proxy.js test            # 测试所有节点连通性
//   node proxy.js start           # 随机启动一个节点作为本地代理
//   node proxy.js start --us      # 启动美国节点
//   node proxy.js start --jp      # 启动日本节点
//   node proxy.js stop            # 停止本地代理
//   node proxy.js list            # 列出所有可用节点
//
// 模块导出：
//   startProxy(opts)  → { proxyUrl, nodeInfo }  启动代理
//   stopProxy()       → void                     停止代理
//   testAllNodes()    → [{ name, alive, ... }]   测试所有节点

const fs = require('fs');
const path = require('path');
const { execSync, spawn, exec } = require('child_process');

const YAML_FILE = path.join(__dirname, 'ipproxy.yaml');
const SINGBOX_CONFIG = path.join(__dirname, 'sing-box-config.json');
const SINGBOX_BIN = process.env.SINGBOX_BIN || 'sing-box';
const LOCAL_PROXY_PORT = parseInt(process.env.LOCAL_PROXY_PORT || '2080', 10);
const LOCAL_PROXY_URL = `socks5://127.0.0.1:${LOCAL_PROXY_PORT}`;

// ──────────────────────────────────────────────────────────
// 1. YAML 解析（简单解析，适配此文件格式）
// ──────────────────────────────────────────────────────────
function parseYamlProxies() {
    const raw = fs.readFileSync(YAML_FILE, 'utf8');
    const proxies = [];

    // 匹配每个 proxy 条目: - { name: '...', ... }
    const entryRegex = /^\s*- \{\s*name:\s*'([^']+)'\s*,(.*?)\}\s*$/gm;
    let match;
    while ((match = entryRegex.exec(raw)) !== null) {
        const name = match[1];
        const rest = match[2];

        const proxy = { name };

        // helper: extract value, strip trailing comma and quotes
        const extract = (pattern) => {
            const m = rest.match(pattern);
            if (!m) return null;
            return m[1].replace(/^'|'$/g, '').replace(/^"|"$/g, '').replace(/,$/, '');
        };

        proxy.type = extract(/type:\s*(\S+)/);
        proxy.server = extract(/server:\s*(\S+)/);
        const portVal = extract(/port:\s*(\d+)/);
        if (portVal) proxy.port = parseInt(portVal, 10);
        proxy.password = extract(/password:\s*(\S+)/);
        proxy.uuid = extract(/uuid:\s*(\S+)/);
        proxy.sni = extract(/(?:sni|servername):\s*(\S+)/);
        proxy.skipCertVerify = /skip-cert-verify:\s*true/.test(rest);
        proxy.username = extract(/username:\s*(\S+)/);
        proxy.fingerprint = extract(/fingerprint:\s*(\S+)/);
        proxy.clientFingerprint = extract(/client-fingerprint:\s*(\S+)/);

        // 提取 country from name emoji
        const countryM = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
        if (countryM) proxy.countryFlag = countryM[0];

        proxies.push(proxy);
    }
    return proxies;
}

// ──────────────────────────────────────────────────────────
// 2. 节点筛选
// ──────────────────────────────────────────────────────────
function getUsableNodes(proxies) {
    // 只用 hysteria2 + socks5 类型（sing-box 支持）
    return proxies.filter(p => p.type === 'hysteria2' || p.type === 'socks5');
}

function getHY2Nodes(proxies) {
    return proxies.filter(p => p.type === 'hysteria2' && p.server && p.password);
}

function getSocks5Nodes(proxies) {
    return proxies.filter(p => p.type === 'socks5' && p.server && p.port);
}

// ──────────────────────────────────────────────────────────
// 3. 生成 sing-box 配置（HY2 节点 → 本地 SOCKS5）
// ──────────────────────────────────────────────────────────
function generateHY2Config(node) {
    return {
        log: { level: 'warn', timestamp: true },
        inbounds: [{
            type: 'mixed',
            tag: 'mixed-in',
            listen: '127.0.0.1',
            listen_port: LOCAL_PROXY_PORT,
        }],
        outbounds: [
            {
                type: 'hysteria2',
                tag: 'hy2-out',
                server: node.server,
                server_port: node.port || 443,
                password: node.password,
                tls: {
                    enabled: true,
                    server_name: node.sni || 'www.bing.com',
                    insecure: node.skipCertVerify !== false,
                },
            },
            { type: 'direct', tag: 'direct' },
        ],
        route: { rules: [], final: 'hy2-out' },
    };
}

// ──────────────────────────────────────────────────────────
// 4. sing-box 进程管理
// ──────────────────────────────────────────────────────────
let singboxProcess = null;

function stopProxy() {
    if (singboxProcess) {
        try { singboxProcess.kill('SIGTERM'); } catch (_) {}
        singboxProcess = null;
    }
    // 也尝试杀掉端口上的残留进程
    try {
        execSync(`lsof -ti TCP:${LOCAL_PROXY_PORT} | xargs kill 2>/dev/null`, { timeout: 3000 });
    } catch (_) {}
}

function startHY2Proxy(node) {
    return new Promise((resolve, reject) => {
        stopProxy();

        const config = generateHY2Config(node);
        fs.writeFileSync(SINGBOX_CONFIG, JSON.stringify(config, null, 2));

        const child = spawn(SINGBOX_BIN, ['run', '-c', SINGBOX_CONFIG], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        child.stderr.on('data', (d) => {
            const msg = d.toString();
            if (msg.includes('error') || msg.includes('ERROR')) {
                // 非致命错误（如 network update permission）
            }
        });

        const timeout = setTimeout(() => {
            reject(new Error(`sing-box 启动超时 (${node.name})`));
        }, 10000);

        // 轮询等待端口就绪
        const checkInterval = setInterval(() => {
            try {
                execSync(`lsof -ti TCP:${LOCAL_PROXY_PORT}`, { timeout: 1000 });
                clearTimeout(timeout);
                clearInterval(checkInterval);
                singboxProcess = child;
                resolve(LOCAL_PROXY_URL);
            } catch (_) {
                // 端口还没就绪
            }
        }, 300);

        child.on('close', (code) => {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            singboxProcess = null;
            if (code !== 0 && code !== null) {
                reject(new Error(`sing-box 退出码 ${code}`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            clearInterval(checkInterval);
            singboxProcess = null;
            reject(err);
        });
    });
}

// ──────────────────────────────────────────────────────────
// 5. 连通性测试
// ──────────────────────────────────────────────────────────
async function testProxyConnection(proxyUrl, timeoutMs = 8000) {
    try {
        const resp = await fetch('https://httpbin.org/ip', {
            signal: AbortSignal.timeout(timeoutMs),
            // Node fetch doesn't support socks directly, use curl as fallback
        });
        return false; // node fetch can't do SOCKS natively
    } catch (_) {
        return null; // unknown
    }
}

async function testViaCurl(proxyUrl) {
    try {
        const result = execSync(
            `curl -s --connect-timeout 8 --max-time 12 --socks5 127.0.0.1:${LOCAL_PROXY_PORT} 'https://httpbin.org/ip'`,
            { timeout: 15000, encoding: 'utf8' }
        );
        const ip = JSON.parse(result).origin;
        return { alive: true, exitIp: ip };
    } catch (_) {
        return { alive: false, exitIp: null };
    }
}

async function testNode(node) {
    const tag = node.name;
    console.log(`\n[测试] ${tag}`);

    if (node.type === 'hysteria2') {
        try {
            await startHY2Proxy(node);
            // 等待代理稳定
            await new Promise(r => setTimeout(r, 2000));
            const result = await testViaCurl(LOCAL_PROXY_URL);
            stopProxy();
            if (result.alive) {
                console.log(`  ✅ 连通 | 出口IP: ${result.exitIp}`);
            } else {
                console.log(`  ❌ 不通`);
            }
            return { ...node, alive: result.alive, exitIp: result.exitIp };
        } catch (e) {
            console.log(`  ❌ 错误: ${e.message}`);
            stopProxy();
            return { ...node, alive: false, exitIp: null };
        }
    }

    if (node.type === 'socks5') {
        const proxyAddr = `${node.server}:${node.port}`;
        try {
            const result = execSync(
                `curl -s --connect-timeout 8 --max-time 12 ` +
                `--socks5 '${proxyAddr}' ` +
                `--proxy-user '${node.username || ''}:${node.password || ''}' ` +
                `'https://httpbin.org/ip'`,
                { timeout: 15000, encoding: 'utf8' }
            );
            const ip = JSON.parse(result).origin;
            console.log(`  ✅ 连通 | 出口IP: ${ip}`);
            return { ...node, alive: true, exitIp: ip };
        } catch (_) {
            console.log(`  ❌ 不通`);
            return { ...node, alive: false, exitIp: null };
        }
    }

    console.log(`  ⏭️  跳过 (type=${node.type})`);
    return { ...node, alive: false, exitIp: null, skipped: true };
}

// ──────────────────────────────────────────────────────────
// 6. 批量测试
// ──────────────────────────────────────────────────────────
async function testAllNodes(filterCountry) {
    const allProxies = parseYamlProxies();
    const hy2Nodes = getHY2Nodes(allProxies);
    const socks5Nodes = getSocks5Nodes(allProxies);

    console.log(`共 ${allProxies.length} 个节点 (HY2: ${hy2Nodes.length}, SOCKS5: ${socks5Nodes.length})`);
    console.log('═══════════════════════════════════════');

    const results = [];
    const testCandidates = [...hy2Nodes];

    // 按国家过滤
    let filtered = testCandidates;
    if (filterCountry === 'us') {
        filtered = testCandidates.filter(n => n.name.includes('美国') || n.name.includes('United States'));
    } else if (filterCountry === 'jp') {
        filtered = testCandidates.filter(n => n.name.includes('日本') || n.name.includes('Japan'));
    } else if (filterCountry === 'sg') {
        filtered = testCandidates.filter(n => n.name.includes('新加坡') || n.name.includes('Singapore'));
    } else if (filterCountry === 'eu') {
        filtered = testCandidates.filter(n =>
            n.name.includes('荷兰') || n.name.includes('德国') || n.name.includes('英国') ||
            n.name.includes('法国') || n.name.includes('Netherlands') || n.name.includes('Germany') ||
            n.name.includes('United Kingdom') || n.name.includes('France')
        );
    }

    // 去重（按 server:port）
    const seen = new Set();
    const unique = [];
    for (const n of filtered) {
        const key = `${n.server}:${n.port}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(n);
        }
    }
    console.log(`测试 ${unique.length} 个独立 HY2 节点 (去重后)...`);

    for (let i = 0; i < unique.length; i++) {
        const node = unique[i];
        console.log(`\n[${i + 1}/${unique.length}] ${node.name} (${node.server}:${node.port})`);
        const result = await testNode(node);
        results.push(result);
        // 节点间短暂休息
        await new Promise(r => setTimeout(r, 1000));
    }

    // 汇总
    console.log('\n═══════════════════════════════════════');
    console.log('  测试汇总');
    console.log('═══════════════════════════════════════');
    const alive = results.filter(r => r.alive);
    const dead = results.filter(r => !r.alive);
    console.log(`  ✅ 存活: ${alive.length}`);
    console.log(`  ❌ 失效: ${dead.length}`);

    if (alive.length > 0) {
        console.log('\n  可用节点:');
        for (const n of alive) {
            console.log(`    ${n.name} → ${n.exitIp}`);
        }
        // 生成 PROXY_LIST
        console.log('\n  .env PROXY_LIST (本地 SOCKS5 端口随机选择节点):');
        console.log(`  PROXY_LIST=socks5://127.0.0.1:${LOCAL_PROXY_PORT}`);
        console.log('\n  ⚠️  使用前需先启动代理: node proxy.js start [--us|--jp|--sg|--eu]');
    }

    return results;
}

// ──────────────────────────────────────────────────────────
// 7. CLI 入口
// ──────────────────────────────────────────────────────────
async function cli() {
    const args = process.argv.slice(2);
    const cmd = args[0] || 'test';
    const flag = args[1] || '';

    if (cmd === 'test') {
        const country = flag.startsWith('--') ? flag.slice(2) : '';
        await testAllNodes(country);
        process.exit(0);
    }

    if (cmd === 'start') {
        const allProxies = parseYamlProxies();
        const hy2Nodes = getHY2Nodes(allProxies);

        let pool = hy2Nodes;
        const country = flag.startsWith('--') ? flag.slice(2) : '';
        if (country === 'us') {
            pool = hy2Nodes.filter(n => n.name.includes('美国') || n.name.includes('United States'));
        } else if (country === 'jp') {
            pool = hy2Nodes.filter(n => n.name.includes('日本') || n.name.includes('Japan'));
        } else if (country === 'sg') {
            pool = hy2Nodes.filter(n => n.name.includes('新加坡') || n.name.includes('Singapore'));
        } else if (country === 'eu') {
            pool = hy2Nodes.filter(n =>
                n.name.includes('荷兰') || n.name.includes('德国') || n.name.includes('英国') ||
                n.name.includes('法国') || n.name.includes('Netherlands')
            );
        }

        // 去重
        const seen = new Set();
        pool = pool.filter(n => {
            const k = `${n.server}:${n.port}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        if (pool.length === 0) {
            console.error('没有匹配的节点');
            process.exit(1);
        }

        const node = pool[Math.floor(Math.random() * pool.length)];
        console.log(`启动代理: ${node.name} (${node.server}:${node.port})`);
        try {
            await startHY2Proxy(node);
            console.log(`✅ 本地代理已启动: ${LOCAL_PROXY_URL}`);
            console.log(`   节点: ${node.name}`);
            console.log(`   进程 PID: ${singboxProcess?.pid || 'unknown'}`);
            console.log('\n   按 Ctrl+C 停止');
            // 保持运行
            process.on('SIGINT', () => { stopProxy(); process.exit(0); });
            process.on('SIGTERM', () => { stopProxy(); process.exit(0); });
            // 持续运行
            await new Promise(() => {});
        } catch (e) {
            console.error(`❌ 启动失败: ${e.message}`);
            process.exit(1);
        }
    }

    if (cmd === 'stop') {
        stopProxy();
        console.log(`✅ 已停止端口 ${LOCAL_PROXY_PORT} 上的代理`);
        process.exit(0);
    }

    if (cmd === 'list') {
        const allProxies = parseYamlProxies();
        const hy2 = getHY2Nodes(allProxies);
        const socks5 = getSocks5Nodes(allProxies);
        console.log(`HY2 节点 (${hy2.length}):`);
        // 去重
        const seen = new Set();
        for (const n of hy2) {
            const k = `${n.server}:${n.port}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const country = (n.name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u) || [''])[0];
            console.log(`  ${country} ${n.name} → ${n.server}:${n.port}`);
        }
        console.log(`\nSOCKS5 节点 (${socks5.length}):`);
        for (const n of socks5) {
            console.log(`  ${n.name} → ${n.server}:${n.port}`);
        }
        process.exit(0);
    }

    console.log('用法: node proxy.js [test|start|stop|list] [--us|--jp|--sg|--eu]');
    process.exit(1);
}

// ──────────────────────────────────────────────────────────
// 8. 模块导出（供 index.js 使用）
// ──────────────────────────────────────────────────────────
module.exports = { startHY2Proxy, stopProxy, testAllNodes, getHY2Nodes, getSocks5Nodes, parseYamlProxies, LOCAL_PROXY_URL, LOCAL_PROXY_PORT };

if (require.main === module) {
    cli().catch(err => {
        console.error(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
