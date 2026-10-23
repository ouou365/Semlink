# 🧠 Semlink — Ask your vault. Watch it think.

**English** | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

An Obsidian plugin that turns years of notes into an agentic knowledge workspace: a transparent AI agent that lives where you write, searches everything you've ever noted, reasons over it with real tools, and answers with numbered citations you can click.

**Agent inside your vault • Thinking + tool calls, visible • Clickable citations • Local SQLite index — no server • Any OpenAI/Anthropic-compatible provider • MCP for Claude & Cursor • 11 languages • Free core, one-time Pro**

<br>

Official site: [getsemlink.com](https://getsemlink.com) · [Pro license — $3 early bird](https://getsemlink.com) · [Issues](https://github.com/ouou365/Semlink/issues)

🤔 Why Semlink? | 🚀 Quick start | ✨ Features | 🤖 Bring your own model | 🌐 MCP | ❓ FAQ

← If Semlink earns its place in your sidebar, drop a star ⭐ — it's the only marketing an indie plugin has.

## 🤔 Why Semlink?

You've written for years. Then you ask a question about your own knowledge — and the workflow is: remember which folder, Ctrl+F, copy-paste into a chat window, lose the thread.

Other Obsidian AI plugins will chat with your notes. What they won't show you is the work. Most RAG plugins retrieve a few chunks behind a black box and answer anyway — wrong chunks, confident tone. Smart Connections finds related notes but never answers. Omnisearch stops at keywords. And the "serious" path — pasting notes into ChatGPT or driving Claude Code from a terminal — means your knowledge lives somewhere other than your editor.

Semlink is built the other way around:

**The agent lives inside your vault — and you watch it work.** Every answer comes with the model's thinking process, every tool call it made (`search_notes` → `get_note` → …), and numbered citations pointing back into your own notes. You don't have to trust the answer. You check it.

### How we compare

| | Semlink | Copilot-style RAG | Smart Connections | Omnisearch | ChatGPT / Claude Code |
|---|---|---|---|---|---|
| Where the AI lives | ✅ Inside Obsidian | 🟡 Chat panel only | 🟡 Related notes only | 🟡 Search box only | ❌ Browser / terminal |
| Agent loop (search → read → reason) | ✅ 9 tools, model decides | ❌ Fixed chunk retrieval | ❌ No Q&A | ❌ | ✅ but outside your editor |
| Reasoning transparency | ✅ Thinking + tool traces | ❌ Black box | — | — | 🟡 Terminal scrollback |
| Citations into your notes | ✅ Numbered, clickable | 🟡 Chunk refs | ❌ | ❌ | ❌ |
| Index location | ✅ Local SQLite, no server | ✅ Local | ✅ Local | ✅ Local | — |
| Other AIs can read your vault (MCP) | ✅ Built in | ❌ | ❌ | ❌ | 🟡 Via terminals |
| Pricing | ✅ Free core + one-time Pro | BYOK | Free | Free | Subscription |

### Three choices we made on purpose

🗄️ **Local-first, structurally.** Your index is a SQLite file on your own disk. There is no Semlink server — not "we promise not to upload your notes", there is literally nothing to upload to.

🔌 **Any model you already pay for.** DeepSeek, GLM, SiliconFlow, OpenAI, Claude, Ollama, LM Studio — any OpenAI- or Anthropic-compatible endpoint. Semlink adds no markup and never touches your tokens; usage is billed by your provider, directly to you.

🪟 **A vault citizen.** Drag a note into the chat to attach it, save answers back as notes, watch the context ring fill in real time. Indexing steps aside while you type. The agent works where your notes already live — nothing to export, nothing to sync.

## 🎯 Is it for me?

**✅ Yes, if you:**

- Have months (or years) of notes and want to *ask* them questions in plain language
- Want reasoning you can inspect — thinking, tool calls, citations — not a confident black box
- Care that your notes never leave your machine
- Already have an LLM API key (or run a local model) and resent middleman markups
- Use Claude Desktop, Claude Code or Cursor — and want them to read your vault too

**❌ No, if you:**

- Want a general ChatGPT replacement — Semlink answers from your vault, not the internet
- Expect zero configuration — you'll need an embedding API key and a chat model key (free tiers work)
- Need team collaboration or cloud sync — there is no backend, by design

## 🚀 Quick start

1. **Install** — one click from the [plugin page](https://community.obsidian.md/plugins/semlink), or search "Semlink" under Settings → Community plugins.
2. **Configure** — paste an embedding API key (SiliconFlow BGE-M3 preconfigured) and a chat provider key. The three-step onboarding validates both and starts indexing.
3. **Ask.** Open the sidebar: *"What have I written about Zettelkasten?"* — then watch: thinking → `search_notes` → `get_note` → an answer with [1][2][3].

That's it. Your notes are never modified — Semlink only reads.

## ✨ Features

### 🕵️ A tool-using agent, not a chatbot

Nine built-in tools — semantic search, read note, read section, similar notes, regex grep, indexed listing (with timestamps), current-note awareness — and the model decides what to pull while answering. It doesn't retrieve three chunks and hallucinate over them; it searches, reads the right section, and shows every step.

### 🔍 Semantic search that reaches everything

Query by meaning, not keywords — one natural-language query touches every note you've ever written. Similar-note suggestions and regex grep are there for when you *do* know the exact string.

### 🪟 A vault citizen

- **Drag & drop**: drop a note anywhere in the panel to attach it — `[[wiki-links]]` resolve inline
- **Save answers as notes**: one click, back into your vault
- **Context you can see**: a live context ring shows how full the model's window is, with the cache hit rate next to it — so you know why an answer got shallow before you blame the model
- **Home question cards**: curated example prompts, some picked from your own recent notes

### ⚡ Real-time indexing

File changes are picked up automatically and re-embedded as you write — and indexing steps aside while you're working, so the editor never stutters.

### 🌍 11 languages

English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Português, Italiano, Русский — pick in Settings → General.

## 🤖 Bring your own model

Any OpenAI-compatible or Anthropic-compatible endpoint works: DeepSeek (preconfigured), SiliconFlow, GLM, OpenAI, Anthropic, Ollama, LM Studio, OpenRouter — your keys, your rates, unlimited switching. What matters:

- **Chat model**: long context helps — answers quote your notes at length
- **Embedding model**: BGE-M3 (1024-dim) preconfigured via SiliconFlow; any compatible embedding endpoint works
- Model usage is billed by your provider — Semlink never sees a cent of it

## 🌐 MCP — give your other AIs a memory

The same tools ship as a local MCP server, so Claude Desktop, Claude Code and Cursor can search and cite your vault too:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Localhost-only, optional access key. No cloud relay.

## ⭐ Pro — free where it matters

The core is free forever, promised inside the app itself: semantic search, chat with the full agent, indexing, MCP — unlimited, no trial timer. Model tokens are billed by your provider, never by us.

[Pro](https://getsemlink.com) is a **one-time license** (no subscription): unlimited chat history plus history management — search, pin, folders.

## ❓ FAQ

**Is my data sent anywhere?**
Your index lives in `data/` inside the plugin folder, on your disk. The only network calls go to the providers *you* configure. See the [privacy policy](https://getsemlink.com/privacy.html).

**How is this different from Copilot for Obsidian?**
Transparency and the agent loop: you see the thinking and every tool call, the model chooses which notes to read, and answers cite specific notes you can open. If Copilot works for you, keep it — Semlink is for when you want to watch the work.

**Do I need an API key?**
Yes — Semlink is bring-your-own-key by design. Free tiers (SiliconFlow, Groq…) work fine for both embedding and chat.

**Where does the index live?**
`data/vault.db` (SQLite) and `data/vectors.bin` inside the plugin folder. Delete them and re-index anytime; nothing ever leaves your machine.

**Which model should I use?**
Any long-context chat model you like — answers quote your notes at length. Embeddings are cheap and infrequent (BGE-M3).

## 🛠 Commands

| Command | What it does |
|---|---|
| Semlink: Open Search | Open the sidebar chat panel |
| Semlink: Full Reindex | Re-scan all files |
| Semlink: Resume / Pause Index | Control indexing |
| Semlink: Start/Stop MCP Service | Toggle the MCP server |
| Semlink: Toggle Debug Logging | Verbose console diagnostics |
| Semlink: View Index Progress | Open the progress panel |

## 📜 License

MIT — see [LICENSE](LICENSE). The optional Pro license is a one-time purchase and never a subscription.
