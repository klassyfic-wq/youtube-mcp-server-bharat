import { env } from "cloudflare:workers";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GoogleHandler } from "./google-handler";
import { registerYoutubeManagementTools } from "./youtube-management-tools";
import { registerYoutubeUploadTools } from "./youtube-upload-tools";
import { registerVideoWorkflowTools } from "./youtube-video-workflow-tools";
import { registerYoutubeShortsDiscoveryTools } from "./youtube-shorts-discovery-tools";
import { registerAiVideoPlanningTools } from "./youtube-ai-planning-tools";
import { registerVideoMediaManifestTools } from "./youtube-media-manifest-tools";
import { registerVideoVoiceTools } from "./youtube-video-voice-tools";
import { handleAudioArtifactRequest, registerAudioDeliveryTools } from "./youtube-audio-delivery";
import { handleImageArtifactRequest, registerVideoImageTools } from "./youtube-video-image-tools";
import { handleVideoPreviewRequest, registerVideoRendererTools } from "./youtube-video-renderer-tools";
import type { Props } from "./utils";
import { getValidGoogleAccessToken } from "./utils";

function createServer() {
  const server = new McpServer({
    name: "YouTube MCP Server Bharat",
    version: "1.0.0",
  });

  const authProps = getMcpAuthContext()?.props as Props | undefined;

  server.registerTool(
    "get_channel_info",
    { description: "Get information about the authenticated YouTube channel" },
    async () => {
      if (!authProps?.userId) {
        return {
          content: [{ type: "text", text: "Authentication required." }],
          isError: true,
        };
      }

      try {
        const accessToken = await getValidGoogleAccessToken(authProps.userId, env);
        const response = await fetch(
          "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!response.ok) throw new Error(`YouTube API returned ${response.status}`);
        return {
          content: [{ type: "text", text: JSON.stringify(await response.json(), null, 2) }],
        };
      } catch (error) {
        console.error("YouTube channel request failed:", error);
        return {
          content: [{ type: "text", text: "Failed to retrieve YouTube channel information." }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_videos",
    {
      description: "List videos from the authenticated YouTube channel. Supports pagination up to 50 videos per page.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ maxResults, pageToken }) => {
      if (!authProps?.userId) {
        return {
          content: [{ type: "text", text: "Authentication required." }],
          isError: true,
        };
      }

      try {
        const accessToken = await getValidGoogleAccessToken(authProps.userId, env);
        const headers = { Authorization: `Bearer ${accessToken}` };
        const channelResponse = await fetch(
          "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
          { headers },
        );
        if (!channelResponse.ok) throw new Error(`YouTube API error: ${channelResponse.status}`);
        const channelData: any = await channelResponse.json();
        const playlistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!playlistId) {
          return { content: [{ type: "text", text: "No uploads playlist found." }] };
        }

        const params = new URLSearchParams({
          part: "snippet,contentDetails",
          playlistId,
          maxResults: String(maxResults ?? 25),
        });
        if (pageToken) params.set("pageToken", pageToken);
        const response = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
          { headers },
        );
        if (!response.ok) throw new Error(`YouTube API error: ${response.status}`);
        const data: any = await response.json();
        const videos = (data.items ?? []).map((item: any) => ({
          videoId: item.contentDetails?.videoId,
          title: item.snippet?.title,
          description: item.snippet?.description,
          publishedAt: item.snippet?.publishedAt,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({
            videos,
            nextPageToken: data.nextPageToken ?? null,
            totalResults: data.pageInfo?.totalResults ?? videos.length,
          }, null, 2) }],
        };
      } catch (error) {
        console.error("Video list failed:", error);
        return {
          content: [{ type: "text", text: "Failed to retrieve YouTube videos." }],
          isError: true,
        };
      }
    },
  );

  registerYoutubeManagementTools(server, authProps, env);
  registerYoutubeUploadTools(server, authProps, env);
  registerVideoWorkflowTools(server, authProps, env);
  registerYoutubeShortsDiscoveryTools(server, env);
  registerAiVideoPlanningTools(server, authProps, env);
  registerVideoMediaManifestTools(server, authProps, env);
  registerVideoVoiceTools(server, authProps, env);
  registerAudioDeliveryTools(server, authProps, env);
  registerVideoImageTools(server, authProps, env);
  registerVideoRendererTools(server, authProps, env);
  return server;
}

const mcpHandler = createMcpHandler(createServer);

const oauthProvider = new OAuthProvider<Env>({
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
  resourceMetadata: { resource: env.MCP_RESOURCE },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/media/audio/")) {
      return handleAudioArtifactRequest(request, env);
    }
    if (pathname.startsWith("/media/image/")) {
      return handleImageArtifactRequest(request, env);
    }
    if (pathname.startsWith("/media/preview/")) {
      return handleVideoPreviewRequest(request, env);
    }
    return oauthProvider.fetch(request, env, ctx);
  },
};
