#!/bin/bash
# 对单个 drama 测试文件跑完整移植流水线（pg 头 + 异步化 + 语法修复）
set -u
cd /home/ll/Desktop/bot-agent/bot-backend
F="$1"  # e.g. tests/drama/creative-chat.test.ts

# 1) 通用修复轮
npx tsc -p tsconfig.testdrama.json --noEmit --pretty false 2>/dev/null | grep 'error TS' > /tmp/e.txt || true
python3 - <<PYEOF > /tmp/e.json
import re, json, pathlib
out, seen = [], set()
for line in open('/tmp/e.txt'):
    m = re.match(r'(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)', line.strip())
    if not m: continue
    f, ln, col, code, msg = m.groups()
    if not f.startswith('tests/drama'): continue
    lines = pathlib.Path(f).read_text().splitlines()
    offset = sum(len(x)+1 for x in lines[:int(ln)-1]) + int(col) - 1
    if (f, ln, col) in seen: continue
    seen.add((f, ln, col))
    out.append({'file': f, 'offset': offset, 'code': code, 'line': int(ln)})
print(json.dumps(out))
PYEOF
[ -s /tmp/e.json ] && node scripts/codemod-drama2.mjs cascade /tmp/e.json tests >/dev/null 2>&1
[ -s /tmp/e.json ] && node scripts/codemod-drama3.mjs /tmp/e.json >/dev/null 2>&1
node scripts/codemod-drama4.mjs asi "$F" >/dev/null 2>&1
python3 - "$F" <<'PYEOF'
import sys, re, pathlib
f = pathlib.Path(sys.argv[1])
t = f.read_text()
t = re.sub(r'(\.returning\(\)){2,}', '.returning()', t)
t = t.replace('assert.throws(async () =>', 'assert.rejects(async () =>')
lines = t.split('\n')
for i in range(1, len(lines)):
    if re.match(r'^\s*\(await ', lines[i]):
        prev = lines[i-1].rstrip()
        if prev and re.search(r'[)\]\}"A-Za-z0-9_]$', prev) and not re.search(r'[;,:([{=&|+*?<>.!]$', prev) and not prev.endswith('=>'):
            lines[i-1] = prev + ';'
t = '\n'.join(lines)
f.write_text(t)
PYEOF
echo "pipelined: $F"
