#!/bin/bash
# run.sh — 一键启动代理 + GitHub 注册（支持批量 IP 轮换）
#
# 用法:
#   ./run.sh                    # 单次，随机美国节点
#   ./run.sh --jp               # 日本节点
#   ./run.sh --count 5          # 批量注册 5 个，每次换 IP
#   ./run.sh --count 3 --jp     # 日本节点批量 3 个
#
# 依赖: sing-box

set -e
cd "$(dirname "$0")"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

COUNT=1
COUNTRY="--us"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --count) COUNT="$2"; shift 2 ;;
        --us|--jp|--nl|--br) COUNTRY="$1"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# ── 节点池（已验证可用） ──────────────────────────────────
# 格式: key|名称|服务器|端口
ALL_NODES=(
  "us-ai|🇺🇸US-AI|134.195.101.75|20000"
  "us-la|🇺🇸US-LA|108.181.22.153|20000"
  "us-ny|🇺🇸US-NY|160.202.167.53|20000"
  "jp|🇯🇵JP-Tokyo|203.10.98.186|443"
  "nl|🇳🇱NL|204.10.194.86|20000"
  "br|🇧🇷BR|129.148.39.249|20000"
)

PASSWORD="${HYSTERIA2_PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
    echo "缺少 HYSTERIA2_PASSWORD，请在 .env 中配置"
    exit 1
fi
SNI="www.bing.com"

# 按国家筛选节点
function pick_node() {
    local candidates=()
    for nd in "${ALL_NODES[@]}"; do
        IFS='|' read -r key _ _ _ <<< "$nd"
        if [[ "$COUNTRY" == "--us" && "$key" == us-* ]]; then candidates+=("$nd")
        elif [[ "$COUNTRY" == "--$key" ]]; then candidates+=("$nd"); fi
    done
    # fallback: 所有节点
    [[ ${#candidates[@]} -eq 0 ]] && candidates=("${ALL_NODES[@]}")
    local idx=$(python3 -c "import secrets; print(secrets.randbelow(${#candidates[@]}))")
    echo "${candidates[$idx]}"
}

# ── 单次运行 ──────────────────────────────────────────────
function run_once() {
    local round="$1"
    local node_info=$(pick_node)
    IFS='|' read -r _KEY NAME SERVER PORT <<< "$node_info"

    # 随机端口（避免冲突）
    local LPORT=$(python3 -c "import secrets; print(2100 + secrets.randbelow(100))")
    while lsof -ti TCP:$LPORT >/dev/null 2>&1; do LPORT=$((LPORT+1)); done

    # 生成 sing-box 配置
    python3 -c "
import json
cfg={
  'log':{'level':'warn'},
  'inbounds':[{'type':'mixed','tag':'in','listen':'127.0.0.1','listen_port':$LPORT}],
  'outbounds':[
    {'type':'hysteria2','tag':'out','server':'$SERVER','server_port':$PORT,'password':'$PASSWORD','tls':{'enabled':True,'server_name':'$SNI','insecure':True}},
    {'type':'direct','tag':'direct'}
  ],
  'route':{'rules':[],'final':'out'}
}
with open('/tmp/singbox-$LPORT.json','w') as f: json.dump(cfg,f)
"

    # 启动
    sing-box run -c "/tmp/singbox-$LPORT.json" >/dev/null 2>&1 &
    local sb_pid=$!

    # 等待就绪
    for i in $(seq 1 30); do
        lsof -ti TCP:$LPORT >/dev/null 2>&1 && break
        sleep 0.3
    done

    # 验证
    local exit_ip=$(curl -s --connect-timeout 8 --max-time 12 \
        --socks5 127.0.0.1:$LPORT 'https://httpbin.org/ip' 2>/dev/null | \
        python3 -c "import sys,json; print(json.load(sys.stdin).get('origin','FAIL'))" 2>/dev/null || echo "FAIL")

    if [ "$exit_ip" = "FAIL" ]; then
        echo "  ❌ 代理不通，跳过"
        kill $sb_pid 2>/dev/null
        return 1
    fi

    echo "  [$round/$COUNT] $NAME → $exit_ip (port $LPORT)"
    echo ""

    # 运行注册
    local started=$(date +%s)
    PROXY="socks5://127.0.0.1:$LPORT" \
    HEADLESS="${HEADLESS:-false}" \
    CAPTCHA_API_KEY="${CAP_2Captcha_KEY}" \
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-.browsers}" \
        node index.js 2>&1 | sed 's/^/    /'
    local rc=${PIPESTATUS[0]}
    local took=$(($(date +%s) - started))

    # 清理
    kill $sb_pid 2>/dev/null
    rm -f "/tmp/singbox-$LPORT.json"
    rm -rf .chrome-profile

    if [ $rc -eq 0 ]; then
        echo "  ✅ 完成 (${took}s)"
    else
        echo "  ❌ 失败 (${took}s, exit=$rc)"
    fi
    return $rc
}

# ── 主流程 ─────────────────────────────────────────────────
echo "═══════════════════════════════════════"
echo "  GitHub 注册 (批量×${COUNT}, IP轮换)"
echo "═══════════════════════════════════════"
echo ""

SUCCESS=0
FAILED=0
for ((i=1; i<=COUNT; i++)); do
    if run_once $i; then
        SUCCESS=$((SUCCESS+1))
    else
        FAILED=$((FAILED+1))
    fi
    # 批次间短暂休息
    if [ $i -lt $COUNT ]; then
        sleep $(python3 -c "import secrets; print(secrets.randbelow(5) + 2)")
    fi
done

echo ""
echo "═══════════════════════════════════════"
echo "  结果: $SUCCESS 成功 / $FAILED 失败"
echo "═══════════════════════════════════════"
