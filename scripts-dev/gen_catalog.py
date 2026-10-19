# 用 TypingMind 抓取的模型目录刷新 Semlink 内置 CHAT_CATALOG 的 models 数组。
# 按条目切割替换（单条目内只有一个 models 数组，不会跨条目误匹配）。
import io
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CATALOG = 'src/settings-models.ts'
MODELS_JSON = 'typingmind-models.json'

# 抓取 vendor → 目录条目 name（只映射目录里已存在、端点明确的）
VENDOR_MAP = {
    'OpenRouter': 'OpenRouter',
    'Vercel AI Gateway': 'Vercel AI Gateway',
    'Groq': 'Groq',
    'Mistral': 'Mistral',
    'Z.AI': 'Z.AI',
    'Xiaomi': 'Xiaomi',
    'Deepseek': 'DeepSeek',
    'Google': 'Google',
    'Anthropic': 'Anthropic',
    'OpenAI': 'OpenAI',
    'Fireworks AI': 'Fireworks',
}
# 无目录条目/端点不明：Deepinfra、Novita、Chutes、Perplexity AI、Alibaba Cloud、
# Ollama Cloud、SpaceXAI、OpenCode Go、OpenAI via Setapp、Meta、Sakana AI

data = json.load(io.open(MODELS_JSON, encoding='utf-8'))
by_vendor = {v['vendor']: v['models'] for v in data['vendors']}


def model_to_ts(m):
    """抓取条目 → ChatModel 字面量文本；不可用返回 None。"""
    mid = m.get('modelID') or ''
    if not mid or ':batch' in mid:
        return None
    fields = [f'id: "{mid}"']
    cw = m.get('contextLength')
    fields.append(f'contextWindow: {cw if isinstance(cw, (int, float)) and cw > 0 else 32768}')
    cost = m.get('cost') or {}
    if isinstance(cost.get('prompt'), (int, float)):
        fields.append(f'priceIn: {round(cost["prompt"] * 1e6, 4)}')
    if isinstance(cost.get('completion'), (int, float)):
        fields.append(f'priceOut: {round(cost["completion"] * 1e6, 4)}')
    return '{ ' + ', '.join(fields) + ' }'


with io.open(CATALOG, 'r', encoding='utf-8') as f:
    t = f.read()

# 定位 CHAT_CATALOG 数组体，按条目（\t{ 开头）切割
cat_start = t.find('export const CHAT_CATALOG: CatalogEntry[] = [')
cat_end = t.find('\n];', cat_start)
assert cat_start > 0 and cat_end > cat_start
head = t[:cat_start]
body = t[cat_start:cat_end]
tail = t[cat_end:]

parts = re.split(r'(?=\n\t\{\n)', body)

report = []
for i, part in enumerate(parts):
    nm = re.search(r'\t\tname: "([^"]+)",', part)
    if not nm:
        continue
    name = nm.group(1)
    if name not in VENDOR_MAP:
        continue
    vendor = VENDOR_MAP[name]
    models = by_vendor.get(vendor, [])
    ts_models = []
    seen = set()
    for m in models:
        line = model_to_ts(m)
        if line is None or line in seen:
            continue
        seen.add(line)
        ts_models.append(line)
    if not ts_models:
        report.append(f'  SKIP {vendor} → {name}: 无可用模型')
        continue
    # body 只含模型行；收尾的 \n\t\t], 由 part[end:] 提供（不重复）
    body_lines = 'models: [\n' + '\n'.join('\t\t\t' + x + ',' for x in ts_models)
    # 替换本条目内的 models 数组（条目内只有一个）
    mi = part.find('models: [')
    assert mi > 0, name
    end = part.find('\n\t\t],', mi)
    assert end > 0, name
    parts[i] = part[:mi] + body_lines + part[end:]
    report.append(f'  OK   {vendor} → {name}: {len(ts_models)} 个模型')

t = head + ''.join(parts) + tail
with io.open(CATALOG, 'w', encoding='utf-8', newline='\n') as f:
    f.write(t)

print('\n'.join(report))
