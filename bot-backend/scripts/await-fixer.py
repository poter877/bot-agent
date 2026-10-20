#!/usr/bin/env python3
"""对测试文件循环：esbuild 报 "await can only be used inside async" 时，
把报错行所在的最近函数/箭头/迭代头 async 化；报孤立括号时删行。直到可解析。"""
import re, subprocess, sys, pathlib

f = sys.argv[1]
p = pathlib.Path(f)

def run():
    r = subprocess.run(['npx', 'tsx', '--test', '--test-force-exit', '--test-timeout=5000', f],
                       capture_output=True, text=True, timeout=60,
                       env={**__import__('os').environ, 'DATABASE_URL': 'postgres://postgres:postgres@127.0.0.1:5432/bot_backend_test'})
    return r.stdout + r.stderr

for _ in range(40):
    out = run()
    m = re.search(rf'{re.escape(f)}:(\d+):\d+: ERROR: "await" can only', out)
    if m:
        lines = p.read_text().split('\n')
        i = int(m.group(1)) - 1
        # 向上找函数头
        for j in range(i, max(-1, i - 30), -1):
            l = lines[j]
            if re.search(r'=> \{', l) and 'async' not in l:
                lines[j] = re.sub(r'=> \{', 'async => {', l, count=1)
                break
            if re.search(r'\bfunction \w+\(', l) and 'async' not in l:
                lines[j] = l.replace('function', 'async function', 1)
                break
            if re.search(r'^\s*for \(', l):
                # for 循环体内的 await → 包 IIFE 不优雅；找循环体后的 test 调用
                continue
        else:
            # 可能是 for-of 体内 → 把 for 头所在 test 改 async（简单起见再上找 test(
            for j in range(i, max(-1, i - 60), -1):
                if re.search(r"test\(", lines[j]) and 'async' not in lines[j]:
                    lines[j] = re.sub(r", \(\) => \{", ", async () => {", lines[j], count=1)
                    if lines[j] != p.read_text().split('\n')[j]:
                        break
                    lines[j] = re.sub(r", \(\)", ", async ()", lines[j], count=1)
                    break
        p.write_text('\n'.join(lines))
        continue
    m2 = re.search(rf'{re.escape(f)}:(\d+):\d+: ERROR: Expected', out)
    if m2:
        lines = p.read_text().split('\n')
        i = int(m2.group(1)) - 1
        if lines[i].strip() in ('))', '}))', '));', '}));'):
            del lines[i]
            p.write_text('\n'.join(lines))
            continue
    break

out = run()
pm = re.search(r'^ℹ pass (\d+)', out, re.M)
fm = re.search(r'^ℹ fail (\d+)', out, re.M)
print(f"{f}: pass={pm.group(1) if pm else '?'} fail={fm.group(1) if fm else '?'}")
