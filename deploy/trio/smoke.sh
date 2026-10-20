#!/usr/bin/env bash
# 联调冒烟：逐环验证 bot-backend → ai-drama(/mcp) → hermes gateway 的接线。
# 用法：docker compose up -d --build 之后，在本目录执行 ./smoke.sh
#
# 环节：
#   1. bot-backend 健康 + 服务令牌可读模型目录
#   2. ai-drama /mcp 的 tools/list（Bearer AI_DRAMA_MCP_TOKEN；用户会话同样可用）
#   （Agent 编排已迁桌面宿主——本堆不再部署 gateway，端到端 turn 在桌面侧验收）
set -euo pipefail

BOT_BASE="${BOT_BASE:-http://localhost:30172}"
# drama 子应用挂在 bot-backend 同源（/mcp）；如需单独指定再覆盖
TOKEN="${INTERNAL_SERVICE_TOKEN:?INTERNAL_SERVICE_TOKEN must be set}"
MCP_TOKEN="${AI_DRAMA_MCP_TOKEN:?AI_DRAMA_MCP_TOKEN must be set}"

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

echo "SMOKE PASSED"
