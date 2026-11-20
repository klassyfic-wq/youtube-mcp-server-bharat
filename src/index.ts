
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "youtube-mcp-server-bharat",
    version: "1.0.0"
  });

  server.registerTool(
    "youtube_server_status",
    {
      description: "Check YouTube MCP server status",
      inputSchema: {}
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "YouTube MCP Server Bharat is running!"
        }
      ]
    })
  );

  return server;
}

const handler = createMcpHandler(createServer);

export default {
  fetch(request, env, ctx) {
    return handler(request, env, ctx);
  }
};
