# Semlink / 语义连接

[English](README.md)

一个 Obsidian 插件，将你的 Vault 笔记进行向量化处理，并通过 MCP（Model Context Protocol）服务对外提供语义搜索能力。

让 Claude Desktop、Claude Code、Cursor 等 AI 工具能够直接搜索和读取你的 Obsidian 笔记。

### 功能特性

- **语义搜索**：用自然语言查询 Vault 笔记，基于向量相似度返回最相关的结果
- **实时索引**：文件变更时自动检测并更新向量索引
- **MCP 服务**：通过 HTTP 协议暴露搜索能力，供 AI 客户端调用

### MCP 工具列表

| 工具 | 说明 |
|------|------|
| `search_notes` | 语义搜索笔记，用自然语言查询，返回最相关的笔记片段 |
| `get_note` | 获取笔记的完整内容 |
| `get_similar_notes` | 查找与指定笔记语义相似的其他笔记 |
| `get_section` | 获取笔记中指定标题下的章节内容 |
| `list_indexed` | 列出已索引的笔记 |
| `index_status` | 获取当前索引状态和进度 |
| `reindex` | 触发重新索引（可指定单个文件或全量） |

### 工作原理

```
Obsidian Vault 笔记
        │
        ▼
   文本分块 (Chunking)
        │
        ▼
  SiliconFlow API (BGE-M3)  ──→  向量嵌入
        │
        ▼
  本地存储 (SQLite + Binary)
        │
        ▼
  MCP HTTP Server (:3001)
        │
        ▼
  Claude / Cursor / 其他 AI 客户端
```

### 安装

#### 方式一：从源码构建（开发者）

```bash
# 克隆仓库
git clone https://github.com/ouou365/Semlink.git
cd semlink

# 安装依赖
npm install

# 构建
npm run build

# 将整个目录复制到你的 Obsidian Vault 插件目录
# 例如: MyVault/.obsidian/plugins/semlink/
```

#### 方式二：直接下载

从 Release 页面下载 `main.js`、`manifest.json`、`styles.css`、`sql-wasm.wasm`，放入：

```
你的Vault/.obsidian/plugins/semlink/
```

#### 启用插件

1. 打开 Obsidian → 设置 → 社区插件
2. 找到 **Semlink** 并启用

### 配置

启用插件后，进入 **设置 → Semlink** 进行配置：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| **SiliconFlow API Key** | 在 [siliconflow.cn](https://siliconflow.cn) 注册获取的 API 密钥 | （必填） |
| **嵌入模型** | 向量化使用的模型 | BAAI/bge-m3 |
| **MCP 服务端口** | HTTP 服务监听端口 | 3001 |
| **MCP 访问密钥** | 客户端连接时的认证密钥（留空不验证） | 空 |
| **分块大小** | 每个文本块的最大字符数 | 800 |
| **分块重叠** | 相邻块之间的重叠字符数 | 100 |
| **批量嵌入大小** | 每次 API 调用包含的文本数量 | 64 |
| **请求间隔** | API 请求之间的延迟（毫秒） | 200 |
| **排除路径** | 不参与索引的路径（每行一个） | templates/ 等 |
| **自动索引** | 文件变更时自动更新 | 开启 |

#### 获取 API Key

1. 前往 [siliconflow.cn](https://siliconflow.cn) 注册账号
2. 在控制台创建 API Key
3. 将 Key 填入插件设置

### 连接 AI 客户端

配置完成后，在插件设置页面底部会自动生成客户端配置，直接复制即可。

#### Claude Desktop / Cursor

将以下 JSON 添加到 MCP 配置文件中：

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

如果设置了 MCP 访问密钥：

```json
{
  "mcpServers": {
    "semlink": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "Authorization": "Bearer 你的密钥"
      }
    }
  }
}
```

#### Claude Code

在终端运行：

```bash
# 无密钥
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp

# 有密钥
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp --header "Authorization: Bearer 你的密钥"
```

### 使用

#### 首次索引

1. 配置好 API Key
2. 打开命令面板（`Ctrl/Cmd + P`），搜索 **"Semlink: 开始索引"**
3. 点击状态栏的 **Semlink** 可查看索引进度

#### 日常使用

- 插件会自动监听文件变更并增量更新索引
- 在 AI 客户端中直接提问即可搜索你的笔记

#### 命令

| 命令 | 说明 |
|------|------|
| `Semlink: 全量重建索引` | 重新扫描所有文件 |
| `Semlink: 开始索引` | 开始索引任务 |
| `Semlink: 暂停索引` | 暂停当前索引任务 |
| `Semlink: 启动/停止 MCP 服务` | 切换 MCP 服务状态 |
| `Semlink: 查看索引进度` | 打开进度面板 |

### 数据存储

所有数据仅存储在本地：

| 文件 | 说明 |
|------|------|
| `data/vault.db` | SQLite 数据库，存储文本块元数据 |
| `data/vectors.bin` | 向量索引二进制文件 |

这些文件位于插件目录下，不会上传到任何服务器。

### 嵌入模型选择

| 模型 | 特点 | 最大 Token |
|------|------|-----------|
| BAAI/bge-m3 | 推荐，多语言支持 | 8192 |
| Pro/BAAI/bge-m3 | 增强版，效果更好 | 8192 |
| BAAI/bge-large-zh-v1.5 | 中文优化 | 512 |
| BAAI/bge-large-en-v1.5 | 英文优化 | 512 |

### 技术栈

- **向量嵌入**：SiliconFlow API (BGE-M3, 1024 维)
- **本地存储**：sql.js (SQLite WASM) + 二进制向量文件
- **搜索算法**：暴力余弦相似度
- **通信协议**：MCP over HTTP (JSON-RPC 2.0)

### 开发

```bash
# 开发模式（监听文件变化自动构建）
npm run dev

# 生产构建
npm run build
```

### 注意事项

- 首次全量索引会消耗 SiliconFlow API 额度，笔记较多时注意用量
- 向量搜索在本地内存中执行，大量笔记（10 万+）可能占用较多内存
- MCP 服务默认监听 `127.0.0.1`，仅本机可访问

### License

MIT
