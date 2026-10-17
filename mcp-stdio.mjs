#!/usr/bin/env node
/**
 * MCP 服务器入口（供外部客户端启动）。
 *
 * 外部客户端（Claude Desktop / Cursor / 任意 MCP 客户端）配置：
 *   {
 *     "mcpServers": {
 *       "knowledge-base": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/dsh-knowledge-base-local/mcp-stdio.mjs"]
 *       }
 *     }
 *   }
 *
 * 这一层只做参数转发：真正的装配（loadSettings → KnowledgeStore → 工具集 → core →
 * stdio/HTTP 传输）都在 `src/mcp_stdio.js` 里，两处入口共用同一实现。
 *
 * 支持覆盖（只作用于内存，**不会**写 settings.json）：
 *   --root <dir> / KB_ROOT / DSH_KB_ROOT
 *   --mode local|llm|api / KB_VECTOR_MODE
 *   --readonly / KB_MCP_READONLY=1（只暴露 kb_search / kb_read / kb_list + kb_manage 读 action）
 *   --http [port] / KB_MCP_PORT + --token / KB_MCP_TOKEN（改用 Streamable HTTP，路径 --path，默认 /mcp）
 *
 * 运行 `node mcp-stdio.mjs --help` 看完整说明。stdout 只写 NDJSON 协议数据，日志在 stderr。
 */
import { main } from './src/mcp_stdio.js'
import { errorMessage } from './src/mcp.js'

main().catch((error) => {
  // stdio 模式：stdin 结束即自然退出；http 模式：server 让事件循环继续存活。
  // 这里只处理致命错误，不要覆盖 main() 已经设置的退出码（例如参数错误的是 2）。
  process.stderr.write(`[mcp] 启动失败：${errorMessage(error)}\n`)
  process.exitCode = 1
})
