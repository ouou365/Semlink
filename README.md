# Semlink

[中文](README_CN.md)

Semlink is an Obsidian plugin that vectorizes your Vault notes and adds a **conversational AI assistant** directly in the sidebar — plus an **MCP server** so Claude Desktop, Claude Code, Cursor and other AI tools can search and read your notes.

Ask questions in natural language: Semlink retrieves the most relevant notes, feeds them to your chat model, and answers with a visible thinking process, tool calls and cited sources — all grounded in your own notes.

### Features

- **Semantic Search**: query your Vault in natural language; returns the most relevant chunks by vector similarity
- **Conversational Q&A**: an in-sidebar chat panel where the LLM answers from retrieved notes, with collapsible thinking process, tool-call traces and numbered reference sources
- **Tool-using agent**: the model can search, grep, read notes and inspect your current open note while answering
- **Context management**: prior turns are sent as a native message array (stable prompt prefix → high cache hit rate); the history is trimmed by a sliding window once it approaches the context limit
- **Real-time Indexing**: file changes are picked up automatically; indexing yields while you are actively working
- **MCP Server**: expose search/read tools over HTTP (JSON-RPC) for AI clients
- **Feishu (Lark) bot**: scan a QR code to bind, then chat with your Vault from Feishu via streaming cards

### Chat Panel

- Click the Semlink icon in the left ribbon (or run **Semlink: Open Search**)
- Type a question — the model first thinks, then calls tools if it needs more, then answers with sources below
- **Drag & drop**: drop notes ANYWHERE in the panel — a guidance overlay appears while dragging — to attach them to the input (`[[links]]` supported inline)
- **History**: every conversation is saved; open it from the menu button, first question shown as the header subtitle
- **Model switcher**: pick any model from any configured provider; the context-usage ring and cache hit rate are shown next to it
- **Home question cards**: a curated pool of example prompts (recent notes / the "reading" topic / summarize the current note / knowledge review / duplicate notes / monthly review), three picked at random per visit

### Tools

| Tool | Description |
|------|-------------|
| `search_notes` | Semantic search with natural language queries, returns the most relevant chunks |
| `get_note` | Get the full content of a note |
| `get_section` | Get the content under a specific heading of a note |
| `get_similar_notes` | Find notes semantically similar to a given note |
| `list_indexed` | List indexed note paths (paginated) |
| `list_indexed_detailed` | List indexed notes with created/modified times, newest first (for time-based questions) |
| `grep_notes` | Exact text / regex search across notes (keywords, IDs, dates, code) |
| `get_active_note` | Path of the note currently open in Obsidian (content via `get_note`) |

MCP additionally exposes `index_status` and `reindex` for index management.

### How It Works

```
Obsidian Vault Notes
        │
        ▼
   Text Chunking
        │
        ▼
  Embedding API (BGE-M3)  ──→  Vector Embedding
        │
        ▼
  Local Storage (SQLite + Binary)
        │
        ▼
  Chat Pipeline (retrieval → LLM with tools → answer)
        │                        │
        ▼                        ▼
  Sidebar Chat Panel        MCP HTTP Server (:3001)
                                │
                                ▼
                      Claude / Cursor / Other AI Clients
```

### Installation

#### Option 1: Build from Source

```bash
git clone https://gitee.com/ouzhongyuan/semlink.git
cd semlink
npm install
npm run build
# Copy the whole directory to MyVault/.obsidian/plugins/semlink/
```

#### Option 2: Direct Download

Download `main.js`, `manifest.json`, `styles.css` from the Release page and place them in `YourVault/.obsidian/plugins/semlink/`.

#### Enable

1. Obsidian → Settings → Community plugins
2. Find **Semlink** and enable it

### Configuration

**Settings → Semlink**:

| Section | Setting | Description |
|---------|---------|-------------|
| General | Language | UI language (中文 / English) |
| Index | Exclude Paths | Paths excluded from indexing (one per line) |
| Index | Auto Index | Automatically index on file changes |
| Embedding | Embedding Model | Model used for vectorization (e.g. `BAAI/bge-m3`) |
| Embedding | API Key | SiliconFlow (or HuggingFace) API key |
| Chunking | Chunk Size / Overlap | Characters per chunk and overlap |
| Chunking | Batch Size / Delay | API batching and rate limiting |
| MCP | Port / Access Key | HTTP server port and optional auth key |
| Chat | Provider / Base URL / API Key | Chat model provider (DeepSeek preconfigured; any OpenAI/Anthropic-compatible API works) |
| Chat | Models | Add/remove models, pick the context window size |
| Bot | Feishu Bot | Scan a QR code to bind a Feishu bot (see below) |

### Connect AI Clients

Client configs are auto-generated at the bottom of the plugin settings page.

#### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "semlink": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

With access key:

```json
{
  "mcpServers": {
    "semlink": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer your-key" }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp
# with key:
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp --header "Authorization: Bearer your-key"
```

### Feishu (Lark) Bot

1. Create a bot app in the Feishu open platform (enable bot capability, grant `im:message` / `im:message:send_as_bot` / `cardkit:card:write` etc., subscribe events via long connection)
2. In **Settings → Semlink → Bot**, enter the App ID / App Secret and scan the QR code with your Feishu
3. Send `/bind <code>` to the bot to finish binding
4. Chat with the bot — it replies with streaming cards showing the thinking process, tool calls and the answer

### Commands

| Command | Description |
|---------|-------------|
| Semlink: Open Search | Open the sidebar chat panel |
| Semlink: Full Reindex | Re-scan all files |
| Semlink: Resume Index | Continue paused indexing |
| Semlink: Pause Index | Pause indexing |
| Semlink: Start/Stop MCP Service | Toggle the MCP server |
| Semlink: View Index Progress | Open the progress panel |

### Data Storage

Everything stays local:

| File | Description |
|------|-------------|
| `data/vault.db` | SQLite database (chunk metadata) |
| `data/vectors.bin` | Vector index binary |

Never uploaded anywhere. Indexing consumes embedding API credits (e.g. SiliconFlow BGE-M3).

### Embedding Models

| Model | Feature | Max Tokens |
|-------|---------|-----------|
| BAAI/bge-m3 | Recommended, multilingual | 8192 |
| Pro/BAAI/bge-m3 | Enhanced version | 8192 |
| BAAI/bge-large-zh-v1.5 | Chinese optimized | 512 |
| BAAI/bge-large-en-v1.5 | English optimized | 512 |

### Tech Stack

- **Embedding**: SiliconFlow API (BGE-M3, 1024-dim)
- **Storage**: sql.js (SQLite WASM, embedded in the bundle) + binary vector file
- **Search**: brute-force cosine similarity
- **Chat**: OpenAI / Anthropic-compatible chat APIs with streaming + tool calling
- **MCP**: HTTP transport (JSON-RPC 2.0)
- **Bot**: Feishu long-connection SDK + CardKit streaming cards

### Development

```bash
npm run dev     # watch + auto-rebuild
npm run build   # production build
```

### Notes

- Indexing consumes embedding API credits; watch usage on large Vaults
- Vector search runs in local memory; 100K+ notes may use significant memory
- MCP server binds to `127.0.0.1` by default (localhost only)

### License

MIT
