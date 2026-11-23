import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type VideoJobEnv = Env;
type VideoStage = "brief" | "script" | "assets" | "render" | "review" | "upload" | "completed";
type VideoJob = {
  jobId: string;
  userId: string;
  brief: {
    topic: string;
    title: string;
    language: string;
    durationMinutes: number;
    audience: string;
    aspectRatio: "16:9" | "9:16" | "1:1";
    tone: string;
  };
  stage: VideoStage;
  status: "planning" | "in_progress" | "ready_for_review" | "uploaded_private" | "completed";
  artifacts: Record<string, string>;
  publishApprovedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const STAGES: VideoStage[] = ["brief", "script", "assets", "render", "review", "upload", "completed"];
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

function jobKey(userId: string, jobId: string) {
  return `youtube:video-job:${userId}:${jobId}`;
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  console.error("Video workflow operation failed:", error);
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Video workflow operation failed." }],
    isError: true,
  };
}

async function readJob(env: VideoJobEnv, userId: string, jobId: string): Promise<VideoJob> {
  if (!z.string().uuid().safeParse(jobId).success) throw new Error("Invalid jobId.");
  const raw = await env.OAUTH_KV.get(jobKey(userId, jobId));
  if (!raw) throw new Error("Video job not found or expired.");
  const job = JSON.parse(raw) as VideoJob;
  if (job.userId !== userId) throw new Error("Video job does not belong to this account.");
  return job;
}

async function saveJob(env: VideoJobEnv, job: VideoJob) {
  job.updatedAt = new Date().toISOString();
  await env.OAUTH_KV.put(jobKey(job.userId, job.jobId), JSON.stringify(job), {
    expirationTtl: JOB_TTL_SECONDS,
  });
}

export function registerVideoWorkflowTools(server: McpServer, authProps: Props | undefined, env: VideoJobEnv) {
  server.registerTool(
    "create_video_job",
    {
      description: "Create a tracked AI video-production job from a brief. This creates a workflow record only; it does not itself generate media or call paid AI providers.",
      inputSchema: {
        topic: z.string().trim().min(3).max(500),
        title: z.string().trim().min(1).max(100),
        language: z.string().trim().min(2).max(40),
        durationMinutes: z.number().min(1 / 6).max(180),
        audience: z.string().trim().min(2).max(200),
        aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
        tone: z.string().trim().min(2).max(100).default("clear and engaging"),
      },
    },
    async (brief) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required. Connect your YouTube account first.");
        const now = new Date().toISOString();
        const job: VideoJob = {
          jobId: crypto.randomUUID(),
          userId,
          brief,
          stage: "brief",
          status: "planning",
          artifacts: {},
          createdAt: now,
          updatedAt: now,
        };
        await saveJob(env, job);
        return response({
          ...job,
          nextAction: "Prepare the script and scene plan, then call update_video_job with stage=script and artifact references.",
          note: "No video, audio, image, or paid provider has been generated or invoked by this operation.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_video_job_status",
    {
      description: "Get the authenticated user's AI video-production job, current stage, artifact references, and publishing approval state.",
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        return response(await readJob(env, userId, jobId));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "update_video_job",
    {
      description: "Advance a video job through script, assets, render, review, upload, and completed stages. Store artifact references (not large media bytes); stages cannot move backwards.",
      inputSchema: {
        jobId: z.string().uuid(),
        stage: z.enum(STAGES),
        status: z.enum(["in_progress", "ready_for_review", "uploaded_private", "completed"]).optional(),
        artifacts: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ jobId, stage, status, artifacts }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        const job = await readJob(env, userId, jobId);
        if (STAGES.indexOf(stage) < STAGES.indexOf(job.stage)) {
          throw new Error("Video job stages cannot move backwards.");
        }
        if (status === "ready_for_review" && stage !== "review") {
          throw new Error("ready_for_review status is only valid at the review stage.");
        }
        if (status === "uploaded_private" && stage !== "upload") {
          throw new Error("uploaded_private status is only valid at the upload stage.");
        }
        if (status === "completed" && stage !== "completed") {
          throw new Error("completed status is only valid at the completed stage.");
        }
        job.stage = stage;
        job.status = status ?? (stage === "review" ? "ready_for_review" : stage === "upload" ? "uploaded_private" : stage === "completed" ? "completed" : "in_progress");
        if (artifacts) job.artifacts = { ...job.artifacts, ...artifacts };
        await saveJob(env, job);
        return response(job);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "approve_video_publish",
    {
      description: "Record the user's explicit approval to publish a reviewed video. This records approval only; it does not change YouTube visibility or publish the video.",
      inputSchema: {
        jobId: z.string().uuid(),
        confirmation: z.literal("APPROVE_PUBLIC_PUBLISH"),
      },
    },
    async ({ jobId }) => {
      try {
        const userId = authProps?.userId;
        if (!userId) throw new Error("Authentication required.");
        const job = await readJob(env, userId, jobId);
        if (job.stage !== "review" && job.stage !== "upload" && job.stage !== "completed") {
          throw new Error("Publishing can only be approved after the video reaches review.");
        }
        job.publishApprovedAt = new Date().toISOString();
        await saveJob(env, job);
        return response({
          jobId,
          publishApprovedAt: job.publishApprovedAt,
          note: "Approval recorded only. A separate, explicit YouTube publish operation is still required.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
