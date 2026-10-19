#!/usr/bin/env bash
# 联调冒烟：逐环验证 bot-backend → ai-drama(/mcp) → hermes gateway 的接线。
# 用法：docker compose up -d --build 之后，在本目录执行 ./smoke.sh
#
# 环节：
#   1. bot-backend 健康 + 服务令牌可读模型目录
#   2. ai-drama /mcp 的 tools/list（Bearer AI_DRAMA_MCP_TOKEN）
#   3. hermes gateway /v1/models（需 --profile hermes；未起则 SKIP）
#   4. 端到端一次 chat completion（需 3 + DRAMA_ACCOUNT_EMAIL/DRAMA_ACCOUNT_PASSWORD
#      环境变量：登录 bot-backend 把会话写进 drama home 的 cookie jar，再经
#      gateway 发起一次真实 agent 调用——模型经 bot-backend、工具可经 /mcp）。
set -euo pipefail

BOT_BASE="${BOT_BASE:-http://localhost:30172}"
DRAMA_BASE="${DRAMA_BASE:-http://localhost:30172}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:30175}"
TOKEN="${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN must be set}"
MCP_TOKEN="${AI_DRAMA_MCP_TOKEN:?AI_DRAMA_MCP_TOKEN must be set}"
API_KEY="${API_SERVER_KEY:-}"

fail() { echo "FAIL: $*" >&2; exit 1; }
skip() { echo "SKIP: $*"; }

# ── 1. bot-backend ──────────────────────────────────────────────────────────
for i in $(seq 1 60); do
  curl -fsS "$BOT_BASE/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$BOT_BASE/healthz" >/dev/null || fail "bot-backend not healthy"
echo "OK  bot-backend healthy"

models=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BOT_BASE/api/llm/models") \
  || fail "service token cannot read /api/llm/models"
echo "$models" | grep -q '"models"' || fail "model catalog response malformed"
echo "OK  bot-backend model catalog (service token)"

# ── 2. ai-drama MCP ─────────────────────────────────────────────────────────
mcp=$(curl -fsS -X POST "$DRAMA_BASE/mcp" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') \
  || fail "ai-drama /mcp tools/list failed"
echo "$mcp" | grep -q 'write_file\|read_episode_script\|submit_image_task' \
  || fail "ai-drama /mcp returned no known tools"
echo "OK  ai-drama /mcp tools listed"

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$DRAMA_BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') \
  || fail "unauthenticated /mcp probe failed"
[ "$status" = "403" ] || fail "unauthenticated /mcp should 403, got $status"
echo "OK  ai-drama /mcp fail-closed without token"

# ── 3. hermes gateway ───────────────────────────────────────────────────────
if ! curl -fsS -m 2 "$GATEWAY_BASE/v1/models" -H "Authorization: Bearer ${API_KEY:-x}" >/dev/null 2>&1; then
  skip "hermes gateway not running (start with: docker compose --profile hermes up -d)"
  exit 0
fi
curl -fsS "$GATEWAY_BASE/v1/models" -H "Authorization: Bearer $API_KEY" | grep -q '"data"\|"models"' \
  || fail "gateway /v1/models malformed"
echo "OK  hermes gateway /v1/models"

# ── 4. 端到端 agent 调用 ────────────────────────────────────────────────────
if [ -z "${DRAMA_ACCOUNT_EMAIL:-}" ] || [ -z "${DRAMA_ACCOUNT_PASSWORD:-}" ]; then
  skip "end-to-end turn (set DRAMA_ACCOUNT_EMAIL/DRAMA_ACCOUNT_PASSWORD to enable)"
  exit 0
fi

# 登录必须在容器网络内、对 gateway 实际访问的源（bot-backend:30172）进行，且 jar
# 要用 python 的 MozillaCookieJar 写：curl 格式对无点主机的域处理与 python 不一致
# （python 会把无点主机规范化为 <host>.local），hermes 侧会静默不带 cookie 而 401。
docker compose exec -T hermes-gateway /opt/hermes/.venv/bin/python - "$DRAMA_ACCOUNT_EMAIL" "$DRAMA_ACCOUNT_PASSWORD" <<'PYEOF2' || fail "account sign-in failed (register the account first)"
import http.cookiejar, json, os, sys, urllib.request
email, password = sys.argv[1], sys.argv[2]
path = os.path.join(os.environ["HERMES_HOME"], "account-auth-cookies.txt")
jar = http.cookiejar.MozillaCookieJar(path)
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
req = urllib.request.Request(
    "http://bot-backend:30172/api/auth/sign-in/email",
    data=json.dumps({"email": email, "password": password}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
with opener.open(req, timeout=10):
    pass
jar.save(path, ignore_discard=True)
os.chmod(path, 0o644)  # exec 是 root，gateway 进程非 root：必须世界可读
PYEOF2
echo "OK  drama account session installed"

reply=$(curl -fsS -X POST "$GATEWAY_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"system","content":"你是联调冒烟助手，只回复一个词。"},{"role":"user","content":"回复：pong"}]}' \
  || fail "end-to-end completion failed")
echo "$reply" | grep -q '"content"' || fail "completion response malformed"
echo "OK  end-to-end turn through gateway → bot-backend"
echo "SMOKE PASSED"
