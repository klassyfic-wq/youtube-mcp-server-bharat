
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class YouTubeMCP extends McpAgent {
  server = new McpServer({
    name: "youtube-mcp-server-bharat",
    version: "1.0.0"
  });

  async init() {
    this.server.tool(
      "youtube_server_status",
      "Check YouTube MCP server status",
      {},
      async () => ({
        content: [
          {
            type: "text",
            text: "YouTube MCP Server Bharat is running!"
          }
        ]
      })
    );
  }
}

export default {
  fetch: YouTubeMCP.serve("/sse")
};

