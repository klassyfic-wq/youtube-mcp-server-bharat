import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * This is an explicit rights-attestation gate, not a legal verification service.
 * It prevents a CC metadata label alone from authorizing source-media processing.
 */
export function registerYoutubeShortsRightsTools(server: McpServer) {
  server.registerTool(
    "evaluate_short_source_rights",
    {
      description: "Evaluate the user's rights attestations before any source-media Shorts editing. A YouTube licence label alone never clears third-party music/footage. This tool does not independently verify legal ownership or permission and does not download or edit media.",
      inputSchema: {
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
        licenseMetadata: z.enum(["creativeCommon", "youtube", "unknown"]),
        creatorPermissionConfirmed: z.boolean().describe("For standard/unknown licence, confirm documented permission from the rights holder."),
        thirdPartyAudioCleared: z.boolean().describe("Confirm music, voice, and other third-party audio are cleared or removed."),
        thirdPartyVisualsCleared: z.boolean().describe("Confirm stock footage, images, guests, and other third-party visuals are cleared or removed."),
        attributionPlan: z.string().trim().max(2000).default(""),
        authorizedSourceFileProvided: z.boolean().describe("Confirm the source media file was supplied by the rights holder or obtained through a permitted source."),
      },
    },
    async (input) => {
      const blockers: string[] = [];
      if (input.licenseMetadata !== "creativeCommon" && !input.creatorPermissionConfirmed) {
        blockers.push("Documented creator/rightsholder permission is required for a standard or unknown licence.");
      }
      if (!input.thirdPartyAudioCleared) blockers.push("Third-party audio rights are not confirmed; clear or remove music/voice before editing.");
      if (!input.thirdPartyVisualsCleared) blockers.push("Third-party visual rights are not confirmed; clear or remove footage/images before editing.");
      if (!input.authorizedSourceFileProvided) blockers.push("An authorized source media file has not been provided.");
      if (input.licenseMetadata === "creativeCommon" && !input.attributionPlan.trim()) {
        blockers.push("Provide an attribution plan for the Creative Commons source.");
      }
      return result({
        videoId: input.videoId,
        decision: blockers.length === 0 ? "attestations_complete_pending_human_review" : "blocked",
        mayProceedToShortsPreview: false,
        blockers,
        attributionPlan: input.attributionPlan.trim() || null,
        verification: "User-supplied attestations only; not independently verified legal clearance.",
        nextAction: blockers.length ? "Resolve every blocker and submit the rights assessment again." : "A human reviewer must inspect the source and supporting permission/licence evidence before enabling Shorts editing.",
        note: "No source video was fetched, downloaded, modified, rendered, uploaded, or published.",
      });
    },
  );
}
