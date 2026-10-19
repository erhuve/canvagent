import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CanvasTool, ToolResult } from './runtime.js';

export const canvasServerName = 'canvagent_canvas';
export const canvasTokenEnvironment = 'CANVAGENT_CANVAS_MCP_TOKEN';

/** A request-local, stateless MCP transport keeps tool discovery current without
 * moving or rewriting a Codex conversation. Canvas operations still use the
 * existing service, revisions, persistence and active-turn authorization. */
export async function handleCanvasMcp(req: Request, res: Response, tools: CanvasTool[], call: (name: string, args: unknown) => Promise<ToolResult>) {
  const server = new Server({ name: canvasServerName, version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: 'These are the current tools for the shared Canvagent canvas. Use these tools for drawing, reading, captures and artifacts, including in older conversations with legacy canvas tools. Read before editing, use revision guards, preserve user work, and capture the result to inspect and refine drawings.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
    ...tool,
    annotations: { readOnlyHint: ['read_canvas', 'capture_region'].includes(tool.name), openWorldHint: false },
  })) as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!tools.some(tool => tool.name === request.params.name)) throw new Error('Unknown canvas tool.');
      const result = await call(request.params.name, request.params.arguments ?? {});
      const content: ContentBlock[] = result.contentItems.map(item => {
        if (item.type === 'inputText') return { type: 'text', text: item.text };
        if (item.type === 'inputImage') {
          const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(item.imageUrl);
          if (!match) throw new Error('Canvas capture returned an invalid image.');
          return { type: 'image', mimeType: match[1], data: match[2] };
        }
        throw new Error('Canvas tool returned unsupported content.');
      });
      return { content, isError: !result.success };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Canvas request failed.' }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.once('close', () => { void server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    await server.close();
    throw error;
  }
}
