# Semlink

[中文](README.md)

An Obsidian plugin that vectorizes your Vault notes and exposes semantic search via MCP (Model Context Protocol).

Let Claude Desktop, Claude Code, Cursor and other AI tools directly search and read your Obsidian notes.

### Features

- **Semantic Search**: Query your Vault notes in natural language, return the most relevant results based on vector similarity
- **Real-time Indexing**: Automatically detect file changes and update the vector index
- **MCP Server**: Expose search capabilities via HTTP protocol for AI clients

### MCP Tools

| Tool | Description |
|------|-------------|
| `search_notes` | Semantic search notes using natural language queries, returns the most relevant note chunks |
| `get_note` | Get the full content of a note |
| `get_similar_notes` | Find notes semantically similar to a specified note |
| `get_section` | Get the content under a specific heading in a note |
| `list_indexed` | List all indexed notes |
| `index_status` | Get current indexing status and progress |
| `reindex` | Trigger re-indexing (single file or full) |

### How It Works

```
Obsidian Vault Notes
        │
        ▼
   Text Chunking
        │
        ▼
  SiliconFlow API (BGE-M3)  ──→  Vector Embedding
        │
        ▼
  Local Storage (SQLite + Binary)
        │
        ▼
  MCP HTTP Server (:3001)
        │
        ▼
  Claude / Cursor / Other AI Clients
```

### Installation

#### Option 1: Build from Source (Developers)

```bash
# Clone the repo
git clone https://github.com/ouou365/Semlink.git
cd semlink

# Install dependencies
npm install

# Build
npm run build

# Copy the entire directory to your Obsidian Vault plugins folder
# e.g. MyVault/.obsidian/plugins/semlink/
```

#### Option 2: Direct Download

Download `main.js`, `manifest.json`, `styles.css`, `sql-wasm.wasm` from the Release page and place them in:

```
YourVault/.obsidian/plugins/semlink/
```

#### Enable the Plugin

1. Open Obsidian → Settings → Community plugins
2. Find **Semlink** and enable it

### Configuration

After enabling the plugin, go to **Settings → Semlink**:

| Setting | Description | Default |
|---------|-------------|---------|
| **SiliconFlow API Key** | API key from [siliconflow.cn](https://siliconflow.cn) | (Required) |
| **Embedding Model** | Model used for vectorization | BAAI/bge-m3 |
| **MCP Port** | HTTP server listening port | 3001 |
| **MCP Access Key** | Authentication key for MCP clients (leave empty to disable) | Empty |
| **Chunk Size** | Maximum characters per text chunk | 800 |
| **Chunk Overlap** | Overlap characters between adjacent chunks | 100 |
| **Batch Size** | Number of texts per API call | 64 |
| **Request Delay** | Delay between API requests (ms) | 200 |
| **Exclude Paths** | Paths excluded from indexing (one per line) | templates/ etc. |
| **Auto Index** | Automatically update on file changes | On |

#### Getting an API Key

1. Register at [siliconflow.cn](https://siliconflow.cn)
2. Create an API Key in the console
3. Enter the key in plugin settings

### Connect AI Clients

After configuration, client configs are auto-generated at the bottom of the plugin settings page.

#### Claude Desktop / Cursor

Add the following JSON to your MCP configuration file:

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

With MCP access key:

```json
{
  "mcpServers": {
    "semlink": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "Authorization": "Bearer your-key"
      }
    }
  }
}
```

#### Claude Code

Run in terminal:

```bash
# Without key
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp

# With key
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp --header "Authorization: Bearer your-key"
```

### Usage

#### First Indexing

1. Configure your API Key
2. Open command palette (`Ctrl/Cmd + P`), search for **"Semlink: Start Index"**
3. Click **Semlink** in the status bar to view indexing progress

#### Daily Use

- The plugin automatically watches for file changes and incrementally updates the index
- Ask questions in your AI client to search your notes

#### Commands

| Command | Description |
|---------|-------------|
| `Semlink: Full Reindex` | Re-scan all files |
| `Semlink: Start Index` | Start indexing |
| `Semlink: Pause Index` | Pause current indexing |
| `Semlink: Start/Stop MCP Service` | Toggle MCP server |
| `Semlink: View Index Progress` | Open progress panel |

### Data Storage

All data is stored locally only:

| File | Description |
|------|-------------|
| `data/vault.db` | SQLite database for chunk metadata |
| `data/vectors.bin` | Vector index binary file |

These files are located in the plugin directory and are never uploaded to any server.

### Embedding Models

| Model | Feature | Max Tokens |
|-------|---------|-----------|
| BAAI/bge-m3 | Recommended, multilingual | 8192 |
| Pro/BAAI/bge-m3 | Enhanced version | 8192 |
| BAAI/bge-large-zh-v1.5 | Chinese optimized | 512 |
| BAAI/bge-large-en-v1.5 | English optimized | 512 |

### Tech Stack

- **Embedding**: SiliconFlow API (BGE-M3, 1024-dim)
- **Storage**: sql.js (SQLite WASM) + binary vector file
- **Search**: Brute-force cosine similarity
- **Protocol**: MCP over HTTP (JSON-RPC 2.0)

### Development

```bash
# Dev mode (watch and auto-rebuild)
npm run dev

# Production build
npm run build
```

### Notes

- Full indexing consumes SiliconFlow API credits; watch your usage for large Vaults
- Vector search runs in local memory; 100K+ notes may use significant memory
- MCP server listens on `127.0.0.1` by default, accessible only from localhost

### License

MIT
