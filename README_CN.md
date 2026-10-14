# 🧠 Semlink — 向你的知识库提问，看它思考

**简体中文** | [English](README.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

一个把多年笔记变成"第二大脑"的 Obsidian 插件：一个透明的 AI 智能体住进你写作的地方，检索你写过的每一个字，用真正的工具推理，并给出可点击的编号引用。

**智能体住在库内 • 思考与工具调用可见 • 引用可点击 • 本地 SQLite 索引，没有服务器 • 任意 OpenAI/Anthropic 兼容供应商 • 内置 MCP 给 Claude 和 Cursor • 11 种语言 • 核心免费，Pro 一次性买断**

<br>

官网：[getsemlink.com](https://getsemlink.com) · [Pro 许可证 — 早鸟 $3](https://getsemlink.com) · [问题反馈](https://github.com/ouou365/Semlink/issues)

🤔 为什么是 Semlink？ | 🚀 快速上手 | ✨ 功能 | 🤖 自带模型 | 🌐 MCP | ❓ 常见问题

← 如果 Semlink 值得留在你的侧边栏，点个 ⭐——这是独立开发者唯一的推广方式。

## 🤔 为什么是 Semlink？

你写了很多年。然后想问一个关于自己知识的问题——流程却变成：回忆在哪个文件夹、Ctrl+F、复制粘贴进聊天窗口、丢失上下文。

其他 Obsidian AI 插件也能"和笔记聊天"，但不会让你看到工作过程：多数 RAG 插件在黑盒里检索几个片段就直接回答——片段不对，语气却很自信。Smart Connections 能找相关笔记但从不回答问题。Omnisearch 停在关键词。而"硬核"路线——把笔记贴进 ChatGPT、或在终端里跑 Claude Code——意味着你的知识住在编辑器之外。

Semlink 反着来：

**智能体住进你的库里——而且你看着它干活。** 每个回答都附带模型的思考过程、它调用的每一个工具（`search_notes` → `get_note` → …），以及指回你笔记的编号引用。你不必相信这个回答，你可以检验它。

### 横向对比

| | Semlink | Copilot 类 RAG | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| AI 住在哪里 | ✅ Obsidian 库内 | 🟡 仅聊天面板 | 🟡 仅相关笔记 | 🟡 仅搜索框 | ❌ 浏览器 / 终端 |
| 智能体循环（检索→读→推理） | ✅ 9 个工具，模型自主决定 | ❌ 固定片段检索 | ❌ 无问答 | ❌ | ✅ 但在编辑器之外 |
| 推理透明 | ✅ 思考 + 工具轨迹 | ❌ 黑盒 | — | — | 🟡 终端滚动 |
| 引用回你的笔记 | ✅ 编号可点击 | 🟡 片段引用 | ❌ | ❌ | ❌ |
| 索引位置 | ✅ 本地 SQLite，无服务器 | ✅ 本地 | ✅ 本地 | ✅ 本地 | — |
| 其他 AI 能读你的库（MCP） | ✅ 内置 | ❌ | ❌ | ❌ | 🟡 需终端 |
| 价格 | ✅ 核心免费 + 一次性 Pro | 自带 key | 免费 | 免费 | 订阅制 |

### 三个有意为之的设计

🗄️ **本地优先，是结构使然。** 索引就是你磁盘上的一个 SQLite 文件。Semlink 没有服务器——不是"我们承诺不上传"，而是根本没有可以上传的地方。

🔌 **用你已经在付费的模型。** DeepSeek、GLM、SiliconFlow、OpenAI、Claude、Ollama、LM Studio——任何 OpenAI 或 Anthropic 兼容端点。Semlink 不加价、不经手 token；用量由你的供应商直接计费。

🪟 **库的原住民。** 把笔记拖进对话即可附加，回答一键存回笔记，上下文用量环实时可见。你打字时索引主动让路。智能体在你笔记已经在的地方工作——无需导出，无需同步。

## 🎯 适合我吗？

**✅ 适合，如果你：**

- 积累了几个月甚至几年的笔记，想用自然语言"问"它们
- 想要可检验的推理——思考、工具调用、引用——而不是自信的黑盒
- 在意笔记从不离开你的电脑
- 已有 LLM API key（或跑本地模型），反感中间商加价
- 用 Claude Desktop、Claude Code 或 Cursor——并希望它们也能读你的库

**❌ 不适合，如果你：**

- 想要 ChatGPT 的通用替代——Semlink 只回答来自你库的问题，不联网
- 期望零配置——你需要一个嵌入 API key 和一个对话模型 key（免费额度可用）
- 需要团队协作或云同步——设计上就没有后端

## 🚀 快速上手

1. **安装** — 从 [Releases](https://github.com/ouou365/Semlink/releases) 下载 `main.js`、`manifest.json`、`styles.css` 放入 `你的库/.obsidian/plugins/semlink/`，或从源码构建。在第三方插件中启用。
2. **配置** — 粘贴嵌入 API key（预置 SiliconFlow BGE-M3）和对话供应商 key。三步引导会校验两者并开始索引。
3. **提问。** 打开侧边栏："关于卡片盒笔记法我都写过什么？"——然后看：思考 → `search_notes` → `get_note` → 带 [1][2][3] 的回答。

就这样。你的笔记永远不会被修改——Semlink 只读取。

## ✨ 功能

### 🕵️ 会用工具的智能体，不只是聊天机器人

九个内置工具——语义搜索、读笔记、读章节、相似笔记、正则 grep、索引列表（带时间戳）、当前笔记感知——回答时由模型自主决定取用什么。它不会检索三个片段就硬编：它先搜索、读对章节，并展示每一步。

### 🔍 触达全部笔记的语义搜索

按含义而非关键词查询——一句自然语言触达你写过的每一条笔记。当你确实知道确切字串时，还有相似笔记推荐和正则 grep。

### 🪟 库的原住民

- **拖拽附加**：把笔记拖到面板任意位置——`[[双链]]` 内联解析
- **回答存为笔记**：一键保存回知识库
- **看得见的上下文**：实时上下文环显示模型窗口占用，旁边是缓存命中率——回答变浅时，你先知道原因，而不是怪模型
- **首页问题卡片**：精选示例问题，部分来自你最近的笔记

### ⚡ 实时索引

文件变更自动捕获并随写随嵌入——你工作时索引主动让路，编辑器绝不卡顿。

### 🌍 11 种语言

English、简体中文、繁體中文、日本語、한국어、Deutsch、Français、Español、Português、Italiano、Русский——在 设置 → 通用 中切换。

## 🤖 自带模型

任何 OpenAI 兼容或 Anthropic 兼容端点都可用：DeepSeek（预置）、SiliconFlow、GLM、OpenAI、Anthropic、Ollama、LM Studio、OpenRouter——你的 key、你的费率、随意切换。关键是：

- **对话模型**：长上下文有帮助——回答会大段引用你的笔记
- **嵌入模型**：BGE-M3（1024 维）经 SiliconFlow 预置；任何兼容嵌入端点都行
- 模型用量由你的供应商计费——Semlink 从不经手一分钱

## 🌐 MCP — 让你的其他 AI 也拥有记忆

同样的工具同时以本地 MCP 服务暴露，Claude Desktop、Claude Code 和 Cursor 都能检索并引用你的库：

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

仅监听本机，可选访问密钥。无云端中转。

## ⭐ Pro — 重要的地方免费

核心永久免费，这条承诺写在应用里：语义搜索、完整智能体问答、索引、MCP——不限量、无试用期。模型 token 由你的供应商计费，与我们无关。

[Pro](https://getsemlink.com) 是**一次性许可证**（绝非订阅）：无限对话历史 + 历史管理——搜索、置顶、文件夹。

## ❓ 常见问题

**我的数据会被发送到哪里？**
索引在你的插件文件夹 `data/` 下，位于你的磁盘。仅有的网络请求都发向你配置的供应商。详见[隐私政策](https://getsemlink.com/privacy.html)。

**和 Copilot for Obsidian 有什么区别？**
透明度与智能体循环：你看到思考和每一次工具调用，模型自己决定读哪些笔记，回答引用可以打开的具体笔记。如果 Copilot 够用，留着它——Semlink 是给想看着它干活的人准备的。

**需要 API key 吗？**
需要——Semlink 设计上就是自带 key。免费额度（SiliconFlow、Groq…）对嵌入和对话都够用。

**索引存在哪里？**
插件文件夹内的 `data/vault.db`（SQLite）和 `data/vectors.bin`。随时可删可重建；任何东西都不会离开你的电脑。

**该用哪个模型？**
任意你喜欢的长上下文对话模型——回答会大段引用笔记。嵌入很便宜也不频繁（BGE-M3）。

## 🛠 命令

| 命令 | 说明 |
|---|---|
| Semlink: 打开搜索 | 打开侧边栏聊天面板 |
| Semlink: 全量重建索引 | 重新扫描所有文件 |
| Semlink: 继续 / 暂停索引 | 控制索引 |
| Semlink: 启动/停止 MCP 服务 | 开关 MCP 服务 |
| Semlink: 开关调试日志 | 控制台详细诊断 |
| Semlink: 查看索引进度 | 打开进度面板 |

## 📜 许可证

MIT — 见 [LICENSE](LICENSE)。可选的 Pro 许可证为一次性买断，绝非订阅。
