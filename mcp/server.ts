/**
 * claude-bot MCP Server — 常驻服务，Streamable HTTP transport
 *
 * 通过 HTTP 调用 Bot API (127.0.0.1:3456) 实现所有工具。
 * 监听 127.0.0.1:3457/mcp，支持 POST/GET/DELETE (MCP Streamable HTTP 规范)。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerAllTools } from './tools/index.js';
import { checkHealth } from './api-client.js';

const MCP_PORT = parseInt(process.env.MCP_PORT || '3457', 10);
const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';

// Session → Transport 映射
const transports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'claude-bot', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );
  registerAllTools(server);
  return server;
}

/**
 * 读取请求体（原生 http，不依赖 Express body-parser）
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) { resolve(undefined); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handlePost(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const body = await readBody(req);

  // 复用已有 session
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, body);
    return;
  }

  // 新 session（必须是 initialize 请求）
  if (!sessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // 无效请求
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
    id: null,
  }));
}

async function handleGet(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

async function handleDelete(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or missing session ID');
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

// 启动 HTTP Server
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 健康检查
  if (url.pathname === '/health') {
    const botOk = await checkHealth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bot_api: botOk ? 'connected' : 'unavailable' }));
    return;
  }

  // MCP 端点
  if (url.pathname === '/mcp') {
    try {
      switch (req.method) {
        case 'POST':   await handlePost(req, res); break;
        case 'GET':    await handleGet(req, res); break;
        case 'DELETE': await handleDelete(req, res); break;
        default:
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
      }
    } catch (e) {
      console.error('[MCP] Request error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

httpServer.listen(MCP_PORT, MCP_HOST, async () => {
  const botOk = await checkHealth();
  console.log(`[MCP] claude-bot MCP Server listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
  console.log(`[MCP] Bot API: ${botOk ? 'connected' : 'unavailable (tools will fail until Bot starts)'}`);
});

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('[MCP] Shutting down...');
  for (const [sid, transport] of transports) {
    try { await transport.close(); } catch {}
    transports.delete(sid);
  }
  httpServer.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const [, transport] of transports) {
    try { await transport.close(); } catch {}
  }
  httpServer.close();
  process.exit(0);
});
