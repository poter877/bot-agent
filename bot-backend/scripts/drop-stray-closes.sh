#!/bin/bash
# 迭代删除孤立的 '}))'/'))' 闭合行直到 esbuild 通过（最多 30 轮）
set -u
cd /home/ll/Desktop/bot-agent/bot-backend
F="$1"
for i in $(seq 1 30); do
  ERR=$(timeout 30 env DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/bot_backend_test' npx tsx --test --test-force-exit --test-timeout=5000 "$F" 2>&1 | grep -oE '[0-9]+:[0-9]+: ERROR' | head -1 | cut -d: -f1)
  [ -z "$ERR" ] && break
  python3 - "$F" "$ERR" <<'PYEOF'
import sys, pathlib
f, ln = sys.argv[1], int(sys.argv[2])
p = pathlib.Path(f)
lines = p.read_text().split('\n')
i = ln - 1
# 该行是孤立闭合 → 删；否则往上找最近的孤立闭合行删（误差容错）
for j in (i, i-1, i-2):
    if 0 <= j < len(lines) and lines[j].strip() in ('))', '}))', '));', '}));'):
        del lines[j]
        p.write_text('\n'.join(lines))
        print(f'dropped L{j+1}')
        break
else:
    print('no stray close nearby; stop')
    sys.exit(1)
PYEOF
[ $? -ne 0 ] && break
done
r=$(timeout 45 env DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/bot_backend_test' npx tsx --test --test-force-exit --test-timeout=8000 "$F" 2>/dev/null | grep -E '^ℹ (pass|fail)' | tr '\n' ' ')
echo "$F: $r"
