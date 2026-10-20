#!/bin/bash
# 单文件修复循环：跑 → 抓第一个错误行 → 常见模式自动修 → 重跑（最多 N 轮）
set -u
cd /home/ll/Desktop/bot-agent/bot-backend
F="$1"; ROUNDS="${2:-12}"
for r in $(seq 1 $ROUNDS); do
  OUT=$(timeout 60 env DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/bot_backend_test' npx tsx --test --test-force-exit --test-timeout=8000 "$F" 2>&1)
  P=$(echo "$OUT" | grep '^ℹ pass' | awk '{print $3}'); FL=$(echo "$OUT" | grep '^ℹ fail' | awk '{print $3}')
  echo "round $r: pass=$P fail=$FL"
  [ "$FL" = "0" ] && break
  LINE=$(echo "$OUT" | grep -oE "$F:[0-9]+:[0-9]+: ERROR: [^\n]*" | head -1 | grep -oE ':[0-9]+:' | head -1 | tr -d ':')
  if [ -n "$LINE" ]; then
    bash scripts/fix-line.sh "$F" "$LINE"
  else
    # 非语法错——抓断言/A-M-S 错误页脚
    echo "$OUT" | grep -B 1 -A 4 'AssertionError\|Error:' | head -8 | cut -c1-110
    break
  fi
done
