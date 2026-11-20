import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import type { Props } from "./utils";
import { getValidGoogleAccessToken } from "./utils";

// Context from the auth process, encrypted and stored in the auth token.
// Read it inside the server with `getMcpAuthContext()?.props`.

function createServer() {
	const server = new McpServer({
		name: "YouTube MCP Server Bharat",
		version: "1.0.0",
	});

	const authProps = getMcpAuthContext()?.props as Props | undefined;

	server.registerTool(
		"get_channel_info",
		{
			description: "Get information about the authenticated YouTube channel",
		},
		async () => {
			if (!authProps?.userId) {
				return {
					content: [{ type: "text", text: "Authentication required." }],
					isError: true,
				};
			}

			try {
				const accessToken = await getValidGoogleAccessToken(
					authProps.userId,
					env,
				);

				const response = await fetch(
					"https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true",
					{
						headers: {
							Authorization: `Bearer ${accessToken}`,
						},
					},
				);

				if (!response.ok) {
					throw new Error(`YouTube API returned ${response.status}`);
				}

				const data = await response.json();

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(data, null, 2),
						},
					],
				};
			} catch (error) {
				console.error("YouTube channel request failed:", error);

				return {
					content: [
						{
							type: "text",
							text: "Failed to retrieve YouTube channel information.",
						},
					],
					isError: true,
				};
			}
		},
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
	apiHandler: {
		fetch(request: Request, env: Env, ctx: ExecutionContext) {
			return mcpHandler(request, env, ctx);
		},
	},
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
