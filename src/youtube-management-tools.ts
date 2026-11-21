import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils";
import { getValidGoogleAccessToken } from "./utils";

type YouTubeEnv = Env;

async function getToken(userId: string | undefined, env: YouTubeEnv) {
  if (!userId) throw new Error("Authentication required. Connect your YouTube account first.");
  return getValidGoogleAccessToken(userId, env);
}

async function youtubeRequest(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("YouTube API request failed:", response.status, detail.slice(0, 500));
    throw new Error(`YouTube API request failed (${response.status}). Check API permissions and input.`);
  }
  if (response.status === 204) return null;
  return response.json() as Promise<any>;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  console.error("YouTube management tool failed:", error);
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "YouTube operation failed." }],
    isError: true,
  };
}

export function registerYoutubeManagementTools(
  server: McpServer,
  authProps: Props | undefined,
  env: YouTubeEnv,
) {
  server.registerTool(
    "update_video_details",
    {
      description: "Update an existing YouTube video's title, description and/or tags. Existing fields are preserved when not supplied.",
      inputSchema: {
        videoId: z.string().min(1).describe("YouTube video ID"),
        title: z.string().min(1).max(100).optional(),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string().max(500)).max(500).optional().refine(
          (value) => value === undefined || value.reduce((total, tag) => total + tag.length, 0) <= 500,
          "Combined tag length must not exceed 500 characters.",
        ),
      },
    },
    async ({ videoId, title, description, tags }) => {
      try {
        if (title === undefined && description === undefined && tags === undefined) {
          throw new Error("Provide at least one field to update.");
        }
        const token = await getToken(authProps?.userId, env);
        const current = await youtubeRequest(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
          token,
        );
        const snippet = current.items?.[0]?.snippet;
        if (!snippet) throw new Error("Video not found or not accessible on this channel.");

        // videos.update requires categoryId. Send only writable snippet fields;
        // avoid echoing read-only API fields such as thumbnails and publishedAt.
        const updatedSnippet = {
          title: title ?? snippet.title,
          description: description ?? snippet.description ?? "",
          categoryId: snippet.categoryId,
          ...(snippet.tags ? { tags: snippet.tags } : {}),
          ...(snippet.defaultLanguage ? { defaultLanguage: snippet.defaultLanguage } : {}),
          ...(snippet.defaultAudioLanguage ? { defaultAudioLanguage: snippet.defaultAudioLanguage } : {}),
          ...(tags !== undefined ? { tags } : {}),
        };
        const updated = await youtubeRequest(
          "https://www.googleapis.com/youtube/v3/videos?part=snippet",
          token,
          { method: "PUT", body: JSON.stringify({ id: videoId, snippet: updatedSnippet }) },
        );
        return result(updated);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "delete_video",
    {
      description: "Permanently delete a YouTube video owned by the authenticated channel. This action cannot be undone.",
      inputSchema: { videoId: z.string().min(1).describe("YouTube video ID to permanently delete") },
    },
    async ({ videoId }) => {
      try {
        const token = await getToken(authProps?.userId, env);
        await youtubeRequest(
          `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`,
          token,
          { method: "DELETE" },
        );
        return result({ success: true, videoId, message: "Video deleted." });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_playlists",
    {
      description: "List playlists belonging to the authenticated YouTube channel.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().describe("Maximum playlists to return (default 25)"),
        pageToken: z.string().optional(),
      },
    },
    async ({ maxResults, pageToken }) => {
      try {
        const token = await getToken(authProps?.userId, env);
        const params = new URLSearchParams({
          part: "snippet,contentDetails,status",
          mine: "true",
          maxResults: String(maxResults ?? 25),
        });
        if (pageToken) params.set("pageToken", pageToken);
        return result(await youtubeRequest(
          `https://www.googleapis.com/youtube/v3/playlists?${params}`,
          token,
        ));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_playlist",
    {
      description: "Create a playlist on the authenticated YouTube channel.",
      inputSchema: {
        title: z.string().min(1).max(150),
        description: z.string().max(5000).optional(),
        privacyStatus: z.enum(["private", "public", "unlisted"]).optional(),
      },
    },
    async ({ title, description, privacyStatus }) => {
      try {
        const token = await getToken(authProps?.userId, env);
        const created = await youtubeRequest(
          "https://www.googleapis.com/youtube/v3/playlists?part=snippet,status",
          token,
          {
            method: "POST",
            body: JSON.stringify({
              snippet: { title, ...(description !== undefined ? { description } : {}) },
              status: { privacyStatus: privacyStatus ?? "private" },
            }),
          },
        );
        return result(created);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_channel_analytics",
    {
      description: "Get channel analytics for a date range, including views, watch time, average view duration, and subscriber gains/losses.",
      inputSchema: {
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date in YYYY-MM-DD format"),
      },
    },
    async ({ startDate, endDate }) => {
      try {
        if (startDate > endDate) throw new Error("startDate must be on or before endDate.");
        const token = await getToken(authProps?.userId, env);
        const params = new URLSearchParams({
          ids: "channel==MINE",
          startDate,
          endDate,
          metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
        });
        const analytics = await youtubeRequest(
          `https://youtubeanalytics.googleapis.com/v2/reports?${params}`,
          token,
        );
        return result(analytics);
      } catch (error) {
        return failure(error);
      }
    },
  );
}
