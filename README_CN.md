# Semlink / 语义连接

[English](README.md)

一个 Obsidian 插件：将 Vault 笔记向量化，在侧边栏内置**对话式 AI 助手**，同时提供 **MCP 服务**，让 Claude Desktop、Claude Code、Cursor 等 AI 工具直接搜索和读取你的笔记。

用自然语言提问，Semlink 检索最相关的笔记喂给对话模型，回答时展示思考过程、工具调用轨迹和带编号的参考来源——所有回答都扎根于你自己的笔记。

### 功能特性

- **语义搜索**：用自然语言查询 Vault 笔记，基于向量相似度返回最相关结果
- **对话问答**：侧边栏聊天面板，模型基于检索内容回答，附带可折叠的思考过程、工具调用轨迹、编号参考来源
- **工具调用智能体**：回答过程中模型可自行检索、grep、读取笔记、查看你当前打开的笔记
- **上下文管理**：历史对话以原生消息数组发送（前缀稳定 → 缓存命中率高）；接近上下文上限时按滑动窗口自动截断
- **实时索引**：文件变更自动更新索引；你正在操作时索引自动让路
- **MCP 服务**：通过 HTTP（JSON-RPC）暴露检索/读取工具
- **飞书机器人**：扫码绑定后，直接在飞书里对话，流式卡片回复

### 聊天面板

- 点击左侧 Ribbon 的 Semlink 图标（或执行 **Semlink: 打开搜索**）
- 输入问题——模型先思考，信息不足时调用工具补充，最后给出带来源的回答
- **拖拽附加**：把笔记拖到**面板任意位置**即可附加到输入框（拖入时显示引导遮罩），支持内联 `[[链接]]`
- **历史会话**：对话自动保存，菜单按钮打开；第一条问题显示为面板标题副行
- **模型切换**：可在任意已配置的 Provider 间切换模型，旁边显示上下文用量环和平均缓存命中率
- **首页问题卡片**：精选示例问题池（最近记录 / 「阅读」主题 / 总结当前笔记 / 近期复盘 / 重复笔记 / 月度复盘），每次访问随机抽 3 张

### 工具列表

| 工具 | 说明 |
|------|------|
| `search_notes` | 语义检索，自然语言查询，返回最相关的笔记片段 |
| `get_note` | 获取笔记完整内容 |
| `get_section` | 获取笔记指定标题下的章节内容 |
| `get_similar_notes` | 查找与指定笔记语义相似的笔记 |
| `list_indexed` | 列出已索引笔记路径（分页） |
| `list_indexed_detailed` | 列出笔记及创建/修改时间，最新在前（用于时间类问题） |
| `grep_notes` | 按文本或正则精确搜索（关键词、编号、日期、代码） |
| `get_active_note` | 当前在 Obsidian 中打开的笔记路径（内容请用 `get_note` 读取） |

MCP 额外提供 `index_status` 与 `reindex` 两个索引管理工具。

### 工作原理

```
Obsidian Vault 笔记
        │
        ▼
   文本分块 (Chunking)
        │
        ▼
  嵌入 API (BGE-M3)  ──→  向量嵌入
        │
        ▼
  本地存储 (SQLite + Binary)
        │
        ▼
  对话管线（检索 → LLM 工具调用 → 回答）
        │                        │
        ▼                        ▼
  侧边栏聊天面板          MCP HTTP 服务 (:3001)
                                │
                                ▼
                  Claude / Cursor / 其他 AI 客户端
```

### 安装

#### 方式一：源码构建

```bash
git clone https://gitee.com/ouzhongyuan/semlink.git
cd semlink
npm install
npm run build
# 将整个目录复制到 MyVault/.obsidian/plugins/semlink/
```

#### 方式二：直接下载

从 Release 页面下载 `main.js`、`manifest.json`、`styles.css`，放入 `YourVault/.obsidian/plugins/semlink/`。

#### 启用插件

1. Obsidian → 设置 → 第三方插件
2. 找到 **Semlink** 并启用

### 配置

**设置 → Semlink**：

| 分区 | 设置项 | 说明 |
|------|--------|------|
| 通用 | 语言 | 界面语言（中文 / English） |
| 索引 | 排除路径 | 不参与索引的路径（每行一个） |
| 索引 | 自动索引 | 文件变更时自动更新索引 |
| 嵌入 | 嵌入模型 | 向量化所用模型（如 `BAAI/bge-m3`） |
| 嵌入 | API Key | SiliconFlow（或 HuggingFace）API 密钥 |
| 分块 | 分块大小 / 重叠 | 每个文本块的字符数与重叠 |
| 分块 | 批量大小 / 请求间隔 | API 批处理与限速 |
| MCP | 端口 / 访问密钥 | HTTP 服务端口与可选鉴权密钥 |
| 聊天 | Provider / Base URL / API Key | 对话模型服务商（默认预置 DeepSeek，任何 OpenAI/Anthropic 兼容接口均可） |
| 聊天 | 模型列表 | 增删模型、配置上下文窗口大小 |
| 机器人 | 飞书机器人 | 扫码绑定飞书机器人（见下） |

### 连接 AI 客户端

设置页底部会自动生成各客户端配置。

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

配置了访问密钥时：

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
# 带密钥：
claude mcp add --transport http semlink http://127.0.0.1:3001/mcp --header "Authorization: Bearer your-key"
```

### 飞书机器人

1. 在飞书开放平台创建机器人应用（开启机器人能力，申请 `im:message`、`im:message:send_as_bot`、`cardkit:card:write` 等权限，事件订阅选长连接模式）
2. 在 **设置 → Semlink → 机器人** 填入 App ID / App Secret，用飞书扫码完成授权
3. 向机器人发送 `/bind <code>` 完成绑定
4. 之后直接与机器人对话——它会以流式卡片回复，展示思考过程、工具调用和最终答案

### 命令

| 命令 | 说明 |
|------|------|
| Semlink: 打开搜索 | 打开侧边栏聊天面板 |
| Semlink: 全量重建索引 | 重新扫描所有文件 |
| Semlink: 继续索引 | 恢复暂停的索引 |
| Semlink: 暂停索引 | 暂停索引 |
| Semlink: 启动/停止 MCP 服务 | 开关 MCP 服务 |
| Semlink: 查看索引进度 | 打开进度面板 |

### 数据存储

所有数据仅保存在本地：

| 文件 | 说明 |
|------|------|
| `data/vault.db` | SQLite 数据库（分块元数据） |
| `data/vectors.bin` | 向量索引二进制文件 |

不会上传到任何服务器。索引会消耗嵌入 API 额度（如 SiliconFlow BGE-M3）。

### 嵌入模型

| 模型 | 特点 | 最大 Token |
|------|------|-----------|
| BAAI/bge-m3 | 推荐，多语言 | 8192 |
| Pro/BAAI/bge-m3 | 增强版 | 8192 |
| BAAI/bge-large-zh-v1.5 | 中文优化 | 512 |
| BAAI/bge-large-en-v1.5 | 英文优化 | 512 |

### 技术栈

- **嵌入**：SiliconFlow API（BGE-M3，1024 维）
- **存储**：sql.js（SQLite WASM，已内嵌进产物）+ 二进制向量文件
- **检索**：暴力余弦相似度
- **对话**：OpenAI / Anthropic 兼容聊天接口（流式 + 工具调用）
- **MCP**：HTTP 传输（JSON-RPC 2.0）
- **机器人**：飞书长连接 SDK + CardKit 流式卡片

### 开发

```bash
npm run dev     # 监听并自动重建
npm run build   # 生产构建
```

### 注意事项

- 全量索引会消耗嵌入 API 额度，大库请留意用量
- 向量检索在本地内存运行，10 万+ 笔记可能占用较多内存
- MCP 服务默认只监听 `127.0.0.1`，仅本机可访问

### 许可证

MIT
