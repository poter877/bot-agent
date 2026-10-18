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

BOT_BASE="${BOT_BASE:-http://localhost:3000}"
DRAMA_BASE="${DRAMA_BASE:-http://localhost:5679}"
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:8642}"
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

# 登录 bot-backend，把 Better Auth 会话写成 drama home 的 Netscape cookie jar
# （gateway 的公司模型客户端读 <HERMES_HOME>/account-auth-cookies.txt）。
jar=$(mktemp)
headers=$(mktemp)
curl -fsS -D "$headers" -c "$jar" -X POST "$BOT_BASE/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$DRAMA_ACCOUNT_EMAIL\",\"password\":\"$DRAMA_ACCOUNT_PASSWORD\"}" \
  || fail "account sign-in failed (register the account first)"
docker compose exec -T hermes-gateway sh -c 'mkdir -p "$HERMES_HOME"' >/dev/null
# 宿主机侧 cookie 全程走 mktemp；下面两处 /tmp 都在 hermes-gateway 容器内——宿主机无法为
# docker cp 展开容器里的 $HERMES_HOME，只能先暂存到容器 /tmp，再在容器内落位到 drama home。
docker compose cp "$jar" hermes-gateway:/tmp/cookies.txt >/dev/null  # no-tmp: ok — 容器内路径
# MozillaCookieJar 头：curl 写出的 jar 缺 #HttpOnly_ 前缀也能读，但补上头最稳。
docker compose exec -T hermes-gateway sh -c \
  '{ echo "# Netscape HTTP Cookie File"; cat /tmp/cookies.txt; } > "$HERMES_HOME/account-auth-cookies.txt"'  # no-tmp: ok — 容器内路径
echo "OK  drama account session installed"

reply=$(curl -fsS -X POST "$GATEWAY_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"system","content":"你是联调冒烟助手，只回复一个词。"},{"role":"user","content":"回复：pong"}]}' \
  || fail "end-to-end completion failed")
echo "$reply" | grep -q '"content"' || fail "completion response malformed"
echo "OK  end-to-end turn through gateway → bot-backend"
echo "SMOKE PASSED"
