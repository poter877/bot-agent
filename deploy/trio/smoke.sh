#!/usr/bin/env bash
# 联调冒烟：逐环验证 bot-backend → ai-drama(/mcp) → hermes gateway 的接线。
# 用法：docker compose up -d --build 之后，在本目录执行 ./smoke.sh
#
# 环节：
#   1. bot-backend 健康 + 服务令牌可读模型目录
#   2. ai-drama /mcp 的 tools/list（Bearer AI_DRAMA_MCP_TOKEN）
#   3. hermes gateway /v1/models（核心服务，必检）
#   4. 端到端一次 chat completion（默认执行：网关的模型目录凭据由
#      drama-home-init 播的服务令牌提供，无需账号密码）。
set -euo pipefail

BOT_BASE="${BOT_BASE:-http://localhost:30172}"
# drama 子应用挂在 bot-backend 同源（/mcp）；如需单独指定再覆盖
GATEWAY_BASE="${GATEWAY_BASE:-http://localhost:30175}"
TOKEN="${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN must be set}"
MCP_TOKEN="${AI_DRAMA_MCP_TOKEN:?AI_DRAMA_MCP_TOKEN must be set}"
API_KEY="${API_SERVER_KEY:?API_SERVER_KEY must be set}"

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
mcp=$(curl -fsS -X POST "${DRAMA_BASE:-$BOT_BASE}/mcp" \
  -H "Authorization: Bearer $AI_DRAMA_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') \
  || fail "ai-drama /mcp tools/list failed"
echo "$mcp" | grep -q 'write_file\|read_episode_script\|submit_image_task' \
  || fail "ai-drama /mcp returned no known tools"
echo "OK  ai-drama /mcp tools listed"

status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${DRAMA_BASE:-$BOT_BASE}/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') \
  || fail "unauthenticated /mcp probe failed"
[ "$status" = "403" ] || fail "unauthenticated /mcp should 403, got $status"
echo "OK  ai-drama /mcp fail-closed without token"

# ── 3. hermes gateway ───────────────────────────────────────────────────────
for i in $(seq 1 60); do
  curl -fsS -m 2 "$GATEWAY_BASE/v1/models" -H "Authorization: Bearer $API_KEY" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -m 2 "$GATEWAY_BASE/v1/models" -H "Authorization: Bearer $API_KEY" >/dev/null \
  || fail "hermes gateway not reachable at $GATEWAY_BASE (is the stack up?)"
curl -fsS "$GATEWAY_BASE/v1/models" -H "Authorization: Bearer $API_KEY" | grep -q '"data"\|"models"' \
  || fail "gateway /v1/models malformed"
echo "OK  hermes gateway /v1/models"

# ── 4. 端到端 agent 调用 ────────────────────────────────────────────────────
# 模型目录凭据 = drama-home 播种的服务令牌（/api/llm/models 收 INTERNAL_SERVICE_TOKEN）。
# 旧的用户账号 cookie-jar 方案已移除：python cookiejar 对容器内无点主机名
# （bot-backend）不发 host-only cookie，需专门 workaround，见集成文档排障节。
reply=$(curl -fsS -X POST "$GATEWAY_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"system","content":"你是联调冒烟助手，只回复一个词。"},{"role":"user","content":"回复：pong"}]}' \
  || fail "end-to-end completion failed")
echo "$reply" | grep -q '"content"' || fail "completion response malformed"
echo "OK  end-to-end turn through gateway → bot-backend"
echo "SMOKE PASSED"
