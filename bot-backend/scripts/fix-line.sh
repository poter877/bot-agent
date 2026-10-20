#!/bin/bash
# 对指定行应用常见 pg 移植修复（按模式匹配）
F="$1"; L="$2"
python3 - "$F" "$L" <<'PYEOF'
import sys, pathlib, re
f, ln = sys.argv[1], int(sys.argv[2])
p = pathlib.Path(f)
lines = p.read_text().split('\n')
i = ln - 1
if i >= len(lines): sys.exit(0)
l = lines[i]
orig = l
# 模式集
l = re.sub(r'\(await (eq|and|or)\(', r'\1(', l)                     # where((await eq(
l = re.sub(r'\.get\(\)\), undefined\)', '.length, 0)', l)           # …).get()), undefined
l = re.sub(r'await (\w+)!\.', r'(await \1)!.', l)                   # await x!.y 优先级
l = re.sub(r'\)\)\)\)$', '))', l) if l.count(')') - l.count('(') >= 2 else l
l = re.sub(r'\)\)$', ')', l) if l.count(')') - l.count('(') == 1 and l.rstrip().endswith('))') and not l.rstrip().endswith('};')) else l
if l != orig:
    lines[i] = l
    p.write_text('\n'.join(lines))
    print(f'fixed {f}:{ln}')
PYEOF
