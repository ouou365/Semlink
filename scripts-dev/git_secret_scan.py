#!/usr/bin/env python3
# ========================================
# Semlink - git 全历史密钥模式自检（2026-11-19 外部安全报告核查沉淀）
# ========================================
# 用法：
#   git log --all -p -U0 --no-color -- ':!*.zip' | python3 scripts-dev/git_secret_scan.py
#
# 输出脱敏（只露前 8 字符 + 长度），命中按 (提交, 文件, 模式) 分组。
# 已知误报（本项目）：
#   - token:"down-small-ccm_outlined" —— 飞书消息卡片的 standard_icon 图标名
#     （长度 25 恰好落入 token:"..." 通用模式，外部扫描器即据此误报）；
#   - 72 位 hex 串 —— d3 色板颜色值拼接（a6cee3 1f78b4 b2df8a…）。
# 外部"发现密钥"类报告先跑本脚本核实再谈轮换，避免被通用模式误报牵着走。

import re
import sys

commit = None
curfile = None
findings = {}
pats = [
    ("sk-key", re.compile(r"sk-[A-Za-z0-9_-]{16,}")),
    ("assign-secret", re.compile(
        r'(?:api[_-]?key|apikey|token|secret|passwd|password|pwd|appsecret)["\']?'
        r'\s*[:=]\s*["\'][^"\'\s]{12,}["\']', re.I)),
    ("bearer", re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}")),
    ("pat", re.compile(
        r"ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
        r"|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|whsec_[A-Za-z0-9]{16,}")),
    ("long-hex", re.compile(r"\b[A-Fa-f0-9]{40,}\b")),
    ("webhook", re.compile(r"discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]{20,}")),
]

def redact(m):
    s = m.group(0)
    return s[:8] + "…" + f"<len={len(s)}>"

for line in sys.stdin:
    if line.startswith("commit "):
        commit = line.split()[1][:9]
        curfile = None
    elif line.startswith("+++ b/"):
        curfile = line[6:].strip()
    elif line.startswith("+") and not line.startswith("+++"):
        for name, pat in pats:
            hits = list(pat.finditer(line))
            if not hits:
                continue
            key = (commit, curfile, name)
            findings[key] = findings.get(key, 0) + len(hits)
            if findings[key] <= 2:
                print(f"{commit} {curfile} [{name}] {pat.sub(redact, hits[0].group(0))[:70]}")

print(f"\nTOTAL finding groups: {len(findings)}")
print("注：main.js 的 token:\"down-small-ccm_outlined\" 为飞书图标名（误报）；")
print("72 位 hex 为 d3 色板颜色拼接（误报）。真凭据特征：sk-/ghp_/AKIA/Bearer 长串。")
