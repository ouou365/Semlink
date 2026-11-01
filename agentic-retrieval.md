# Semlink Agentic 检索生成逻辑提炼

> 涉及文件：`src/search-view.ts`（入口与 UI）、`src/chat-client.ts`（Agent 循环）、`src/chat-tools.ts`（工具集）、`src/i18n.ts`（提示词）。
> 一句话概括：**先做一次传统 RAG 向量检索打底，再让 LLM 在"预分析 → 工具调用 → 收敛作答"的有界循环里自主决定读什么、读多深**。

## 总体流程

```
用户提问
   │
   ├─ 拖入了附件？──是──> 直接读附件内容作为上下文（跳过向量检索）
   │
   ├─ 否 ──> embed(query) ──> 向量检索（limit=10, threshold=0.3）
   │           取前 5 条拼成初始上下文（[n] 标题（路径）\n预览）
   │           + 追加"当前正在浏览的笔记"提示行
   │
   ├─ inferAgentDepth(query)：命中 分析/总结/对比/设计 等词 → enhanced，否则 standard
   │
   └─> ChatClient.chat()  ┌────────────────────────────┐
        │                 │  预分析轮（无工具）          │
        │                 │  ↓ 初步结论（thinking 首步） │
        │                 │  工具循环 ≤5 轮              │
        │                 │  ↓ 无 tool_calls → 最终答案  │
        │                 └────────────────────────────┘
        │
        └─> ChatResult { answer, thinking[], usedNotes[], 上下文用量, 缓存命中率 }
```

## 一、初始检索（RAG 基线，非 agentic 部分）

- `client.embed([query])` → `store.search(vec, 10, 0.3)`，取**前 5 条**（`ANSWER_CONTEXT_SIZE`）构建初始上下文，格式 `[序号] 标题（路径）\n内容预览`（`buildNoteContext`）。
- 这批片段只是**参考底料**：系统提示词明确告诉模型"初始检索片段仅供参考，可能无法覆盖所有情况"，时间类/全库类/精确关键词类问题应直接绕过片段调对应工具。
- 拖入附件时以附件为准、不做向量检索；同时注入当前打开笔记的路径，并显式指令"涉及'当前笔记'时直接 get_note，不要把问题原文当检索词"。

## 二、Agent 深度与模式

| 维度 | 取值 | 决定什么 |
|---|---|---|
| `depth` | `standard` / `enhanced`（`inferAgentDepth` 按问题措辞正则推断） | 单个工具结果上限 4000 / 8000 字符；提示词倾向 `get_section` 只读章节 / 允许 `get_note` 读整篇 |
| `agentMode` | `proactive`（默认）/ `classic` | proactive=验证优先，片段提到相关文档就主动去读；classic=保守，片段够用就不调工具 |

两种模式共享：grep 使用指南、工具选择指南、深度提示、"勿编造"、初始上下文、语言规则（输出语言=插件语言设置，与提问语言无关，优先级最高）。

## 三、预分析轮（Pre-analysis）

进入工具循环**之前**先发一次**不带工具**的请求，指令模型"先思考并写出初步结论"：

- 因为没有工具可用，模型被迫把推理写出来 → 这段文本成为用户可见的第一个 thinking 步骤（"初步结论"），解决很多模型直接跳去 tool_calls、用户看不到任何思考的问题。
- 结论保留在会话里，后续工具决策建立在它之上；随后注入一条"进入回答阶段"的 user 消息——否则模型常在分析里说"需要再读 X"却不真的去调工具。
- 失败不致命：直接丢弃该轮，进入正常循环。

## 四、工具循环（Agentic 核心）

`for round = 0..MAX_TOOL_ITERATIONS(5)`，每轮一次流式（SSE）请求，OpenAI 与 Anthropic 两种 wire format 对等实现：

1. **收敛干预**：`round == 3` 或已判定模型在重复自己时，注入"请立即基于已有信息作答"提示，且**请求里不再携带 tools** —— 物理上禁止继续调用。
2. **分支**：
   - 返回无 tool_calls → 这就是最终答案（内容已流式输出给 UI），`finalize`。
   - 返回 tool_calls → 本轮 interim 文本记为 thought 步骤；把 assistant 消息原样回填，逐个执行工具，结果作为 tool message 回填，进入下一轮。
3. **工具执行细节**：执行前先查 abort；每个调用记录 `ThinkingStep(type:"tool")` 供 UI 实时预览与历史回放；`collectUsedNotes` 从工具参数/结果 JSON 里抽取实际进入对话的笔记路径 → 最终"引用来源"卡片。
4. **循环耗尽兜底**：返回模型最后说过的文本（`lastText`），仍无则返回"未找到匹配"的优雅文案，而不是报错。

### 防死循环 / 防重复（三层）

| 层 | 机制 |
|---|---|
| 精确重复 | `callKey = 工具名 + args JSON` 已见过 → 跳过执行，tool 结果回"已检测到重复调用" |
| 近重复 | 同一工具的新 query 与历史 query **互为子串**（长度 ≥4）视为换措辞重搜 → 触发 `forceAnswer` |
| 强制收敛 | `forceAnswer` 后下一轮不带 tools，模型只能作答 |

### 文本式工具调用解析（兼容层）

部分模型（如 DeepSeek）不用结构化 function calling，而是把调用写成文本标记。流结束后若没有结构化 tool_calls，则解析并剥离三种标记：`<invoke name=…><parameter …>`、`<tool_call>{json}`、`<tool_calls>` 包装层，转成真实调用，避免"模型想调工具但系统看不见"。

## 五、工具集（8 个只读工具）

| 工具 | 用途 | 关键实现点 |
|---|---|---|
| `search_notes` | 语义检索 | embed + 向量搜索，默认 limit 10 / threshold 0.3 |
| `get_note` | 读整篇笔记 | 截断到 maxResultChars（按 depth 4000/8000） |
| `get_section` | 按标题读章节 | 找不到标题时返回可用标题清单引导重试 |
| `get_similar_notes` | 笔记→笔记相似 | 对该笔记各 chunk max-pooling（probes=6），避免只比第一段 |
| `list_indexed` | 已索引路径分页 | prefix 过滤 + offset 翻页 |
| `list_indexed_detailed` | 带 ctime/mtime，修改时间倒序 | "最近记了/改了哪些笔记"直接取前几条 |
| `grep_notes` | 精确文本/正则 | 见下 |
| `get_active_note` | 当前打开笔记路径 | 只返回路径，内容再 get_note |

**grep_notes 双路径**：
- 快速路径：非正则且不区分大小写 → SQLite LIKE 打在**已索引 chunks** 上（毫秒级），命中即返回；
- 回退路径：正则/区分大小写 → 全库扫描 `.md/.txt/.markdown`，**并发 32** 读文件、跳过 >5MB、始终返回精确 `totalFiles` 与完整路径清单（≤200，`completeList` 标志），行级明细只保留前 30 个文件、每文件 ≤12 处命中、命中行 ±≤3 行上下文。
- 提示词配套约束："列清单类问题一次 grep_notes 就够，不要换措辞/加 limit 反复搜"。

## 六、上下文管理（ZCode 风格）

- 历史以**原生消息数组**传入（不拼进问题文本）→ 前缀稳定，prompt cache 命中率高；带附件 chip 的用户消息重新展开为 `[[路径]]`。
- 每次请求前滑窗截断：输出预留 `clamp(window×15%, 8k, 32k)`，阈值 `(window−预留)×95%`，从最旧消息开始丢，**永不丢最后的问题**。截断发生在首轮请求之前，同一轮内各 tool round 的前缀保持一致。
- CJK 感知的 token 估算（CJK≈1 字/符，其他≈4 字符/token）；上下文用量环按类别分解：system prompt / 工具 schema / 工具结果 / 消息 / other（API 报了 usage 时 other 吸收差值，否则按估算合计）。
- 缓存命中率按 **token 加权**平均（Σhit/Σtotal），DeepSeek（prompt_cache_hit/miss）与 Anthropic（cache_read/creation）各自的 SSE usage 字段都已适配。

## 七、容错与重试

- 仅**瞬时错误**重试：网络失败（TypeError / failed to fetch / `NETWORK:` 前缀）、429、503、busy/rate limit；用户 abort 永不重试。
- ZCode 式重试曲线：总上限 10 次尝试，退避 1s/1.5s/2s/3s/5s/8s/10s…；**任一请求成功即重置计数**（新故障算新一轮"重新连接中 N/10"），另有总尝试数 backstop 防无限重试。
- 200 但非 SSE（网关错误包裹、错端点）会**响亮报错**而不是解析出零事件后静默空答案。
- 预分析轮失败静默跳过；整轮失败时 UI 保留已发生的 thinking 步骤并退回展示原始检索结果。

## 八、输出与后处理

- 答案流式渲染（仅最终轮内容对外流式，工具轮 interim 文本一律不外露，避免"文字闪现又消失"）。
- **思考提升**：若最终答案 <30 字符而某条 thought ≥80 字符（模型把完整答案写进了初步结论），将该 thought 提升为答案正文。
- `usedNotes`（初始检索 + 工具实际读到的笔记）→ 折叠的引用来源卡片；thinking 步骤、上下文用量、耗时一并落盘到聊天历史，重开可还原。

## 关键常量速查

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_TOOL_ITERATIONS` | 5 | 工具循环上限 |
| `NUDGE_AFTER_ROUND` | 3 | 第几轮起注入"立即作答"并撤掉 tools |
| 初始检索 | limit 10 / threshold 0.3 / 取 5 条进上下文 | |
| `maxResultChars` | 4000（standard）/ 8000（enhanced） | 单个工具结果截断 |
| 近重复判定 | 同工具 query 互为子串且 ≥4 字符 | |
| grep 扫描 | 并发 32、跳过 >5MB、路径 ≤200、明细 ≤30 文件、每文件 12 行、上下文 ≤3 行 | |
| 滑窗阈值 | (window − clamp(15%, 8k~32k)) × 95% | |
| 重试 | 总 10 次，退避 1s→10s，成功即重置 | |
