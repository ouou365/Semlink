# 🧠 Semlink — Agentic Knowledge Workspace

**Let your Obsidian Vault think, collaborate and act.**

**English** | [简体中文](README_CN.md) | [繁體中文](README_zh-Hant.md) | [日本語](README_ja.md) | [한국어](README_ko.md) | [Deutsch](README_de.md) | [Français](README_fr.md) | [Español](README_es.md) | [Português](README_pt.md) | [Italiano](README_it.md) | [Русский](README_ru.md)

Semlink turns your Obsidian vault into an agentic knowledge workspace — an AI assistant that lives in your sidebar, searches everything you've ever noted, reasons over it with real tools, cites every claim back to your notes, and shares what it learns. The whole agent ships inside the plugin: no Claude Desktop, no Cursor, no terminal, no third-party client to install. Bring your own API key, and your vault starts thinking.


![Semlink — agentic knowledge workspace living in the Obsidian sidebar](assets/screenshot-overview.png)

## 🤔 Why Semlink?

You've written for years. Then you ask a question about your own knowledge — and the workflow is: remember which folder, Ctrl+F, copy-paste into a chat window, lose the thread.

Most Obsidian AI plugins depend on third-party agent clients — and those clients are agent applications built for programming. You get a coding assistant that drops by your notes, not an agent that actually works inside them.

Semlink is built the other way around:

**The workspace is the vault, and the agent is built in — not bolted on.** Install the plugin, paste your key, ask. The agent thinks, calls tools, reads your notes and answers with numbered citations — entirely inside Obsidian. You don't have to trust the answer. You watch it being made, then check it.

### Semlink vs. Copilot for Obsidian

| | Semlink | Copilot for Obsidian |
|---|---|---|
| Zero external tools | ✅ Agent, RAG and sharing all built into the plugin | ❌ Agent requires opencode, RAG requires Miyo — separate installs |
| Agent loop (search → read → reason) | ✅ 9 tools, the model decides what to read | 🟡 Routed through an external client |
| Reasoning transparency | ✅ Thinking + tool traces, streamed live inside the plugin | 🟡 The loop happens outside Obsidian |
| Citations | ✅ One numbering registry per turn; click a citation to jump to the note it came from | 🟡 Source notes listed |
| Sharing an answer | ✅ LAN web page + QR code, revoke anytime | ❌ Copy-paste |
| Other AIs can read your vault (MCP) | ✅ Built-in local server | ❌ |

### Choices we made on purpose

🧠 **The agent is a resident, not a visitor.** Everything the agent needs — search, tools, thinking trace, citations, sharing — ships in the plugin. External AI clients are welcome through MCP, but they're an optional bonus, never a prerequisite.

🗄️ **Local-first, structurally.** Your index is a SQLite file on your own disk. There is no Semlink server — not "we promise not to upload your notes", there is literally nothing to upload to.

🔑 **BYOK, without the guesswork.** A catalog of 24 chat vendors (1,800+ models with prices and context windows) and a dedicated embedding-provider catalog get you configured in a couple of clicks; local runtimes like Ollama work with no key at all. Semlink adds no markup and never touches your tokens — your provider bills you directly.

🪟 **A vault citizen.** Drag a note into the chat to attach it, save answers back as notes, watch the context ring fill in real time. Indexing steps aside while you type. The workspace lives where your notes already live — nothing to export, nothing to sync.

## ✨ Signature features

### 🔗 Citations you can actually follow

Every turn runs a single numbering registry across the thinking trace, the answer body and the source cards — the `[3]` in the answer is the same `[3]` you watched the model read. Click a citation and Obsidian opens the note at the exact spot it came from. An answer is only as good as the notes you can check it against — so check.

### 📡 Share an answer without exporting anything

Found something worth showing? One click publishes the whole exchange — question, thinking trace, answer, source cards — as a clean web page on your LAN. Send the link or the QR code; the reader opens it in any browser, no Obsidian, no account, no install. Stop sharing and the page is gone. Nothing ever leaves your network.

### 🪟 Watch the agent work, live

The answer isn't the only output — the reasoning is. Thinking streams as it happens, every tool call (`search_notes` → `get_section` → …) is logged with its result, and the context ring shows how full the model's window is, cache hit rate included. You see exactly what the model saw, which is the whole point.

## 🚀 Quick start

1. **Install** — one click from the [plugin page](https://community.obsidian.md/plugins/semlink), or search "Semlink" under Settings → Community plugins.
2. **Configure** — pick providers from the catalog (or paste a custom endpoint) and add your API key. The three-step onboarding validates chat + embedding and starts indexing.
3. **Ask.** Open the sidebar: *"What have I written about Zettelkasten?"* — then watch: thinking → `search_notes` → `get_note` → an answer with [1][2][3].

That's it. No agent client, no server setup. Your notes are never modified — Semlink only reads.

## 🧠 Think — an agent that shows its work

- **Nine built-in tools**, and the model decides what to pull while answering: semantic search, read note, read section, similar notes, regex grep, indexed listings with timestamps, current-note awareness. It doesn't retrieve three chunks and hallucinate over them; it searches, reads the right section, and shows every step.
- **Thinking you can inspect.** Every answer carries the model's reasoning and each tool call (`search_notes` → `get_section` → …), streamed live — not a confident black box.
- **Citations that check out.** One numbering registry per turn spans the thinking trace, the answer body and the source cards; click a citation to jump straight to the note (and line) it came from.
- **Search that reaches everything**: query by meaning across every note you've ever written, with similar-note suggestions and regex grep for when you *do* know the exact string.

## 🤝 Collaborate — knowledge that leaves the silo (on your terms)

- **Share a conversation over your LAN**: one click publishes the Q&A to a clean web page — send the link or QR code, the reader opens it in any browser, and you revoke sharing anytime. Nothing leaves your network.
- **Answers become notes**: save any response back into your vault with one click.
- **Attach by drag & drop**: drop a note anywhere in the panel — `[[wiki-links]]` resolve inline — and the agent reads it first.
- **Optional: let your other AIs in.** The same tools ship as a local MCP server, so Claude Desktop, Claude Code and Cursor can search and cite your vault too. Strictly optional — the built-in agent needs no help.

## ⚡ Act — control in real time

- **A RAG dashboard, not a progress bar**: vault metrics, real per-note embedding progress, and index / auto-embed toggles that take effect immediately — even mid-run.
- **Reconfigure without ceremony**: change the embedding model and a full re-index starts automatically; the guide revalidates your key and jumps you to the right step.
- **Real-time indexing** that picks up every file change as you write — and steps aside while you're typing, so the editor never stutters.
- **Command-palette control** over indexing, MCP, debug logging and progress.

## 🔑 BYOK — bring your own key

Any OpenAI-compatible or Anthropic-compatible endpoint works — DeepSeek, GLM, SiliconFlow, OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and 1,800+ more through the built-in catalog. What matters:

- **Chat model**: pick from the catalog with prices and context windows shown, or add a custom endpoint (including key-less local runtimes)
- **Embedding model**: a dedicated embedding-provider catalog — SiliconFlow BGE-M3 preconfigured; Jina, Voyage, Nomic, Mixedbread and more, or a local embedding endpoint with no key
- **Your keys, your rates, unlimited switching** — model usage is billed by your provider; Semlink never sees a cent of it

## 🌐 MCP — optional, for your other AIs

The built-in agent is complete on its own. If you also use Claude Desktop, Claude Code or Cursor, the same tools are exposed as a local MCP server:

```json
{ "mcpServers": { "semlink": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Localhost-only, optional access key. No cloud relay.

## ❓ FAQ

**Do I need Claude Desktop, Cursor or any other AI client?**
No. The full agent — thinking trace, tool calls, citations, sharing — runs inside the plugin. MCP exists so external AIs *can* read your vault, never because they must.

**Is my data sent anywhere?**
Your index lives in `data/` inside the plugin folder, on your disk. The only network calls go to the providers *you* configure. LAN sharing stays on your network. See the [privacy policy](https://getsemlink.com/privacy.html).

**How is this different from Copilot for Obsidian?**
Copilot routes its agent through opencode and its RAG through Miyo — external tools you install and run alongside the plugin. Semlink keeps the whole loop inside Obsidian: you see the thinking and every tool call, the model chooses which notes to read, and answers cite specific notes you can open. If Copilot works for you, keep it — Semlink is for when you want the workspace, not more clients.

**Do I need an API key?**
Semlink is BYOK by design — but "your own key" includes key-less local runtimes like Ollama for both chat and embeddings. Cloud free tiers (SiliconFlow, Groq…) work fine too.

**Where does the index live?**
`data/vault.db` (SQLite) and `data/vectors.bin` inside the plugin folder. Delete them and re-index anytime; nothing ever leaves your machine.

**Which model should I use?**
Any long-context chat model you like — answers quote your notes at length. Embeddings are cheap and infrequent (BGE-M3).

## 📜 License

MIT — see [LICENSE](LICENSE). The optional Pro license is a one-time purchase and never a subscription.
