# AI Video Creation + YouTube Automation Architecture

## Product goal

The user should be able to instruct an AI assistant in natural language to create a video for the authenticated YouTube channel, review the result, and publish it after explicit approval.

Example: Create a 5-minute Marathi explainer about the future of AI in India, add Marathi narration and subtitles, prepare a thumbnail, then show a preview. Publish only after approval.

This is a staged, provider-agnostic design. It must not require paid AI subscriptions at the beginning.

## Design principles

- Free-first: prefer existing free allowances, open-source software, and user-owned compute. Never assume a free tier is unlimited or permanent.
- Approval before publishing: generation and upload preparation may be automated; public publishing requires explicit user approval unless a narrowly scoped auto-publish policy is later configured.
- Keep production safe: implement on the feature branch, test in isolation, and do not deploy or merge without user approval.
- Separate orchestration from heavy media processing. Cloudflare Workers are control-plane/API components, not general-purpose long-running video-rendering machines.
- Avoid sending large video files as Base64 or through a single MCP tool request.
- Keep AI/model, voice, image/video generation, and rendering providers replaceable behind adapters.
- Protect OAuth tokens and storage credentials; never log secrets or signed upload URLs.

## Proposed logical workflow

1. **Brief** — AI converts the instruction into a structured brief: language, topic, duration, audience, aspect ratio, tone, and channel.
2. **Research and script** — AI prepares an outline, factual script, scene plan, narration text, and source notes. Flag uncertain claims for review.
3. **Assets** — generate or source visuals, narration, music with appropriate rights, and subtitles. Track provenance and usage rights.
4. **Render** — assemble scenes, audio, captions, and transitions into a preview MP4 using an external rendering worker (for example, FFmpeg on user-owned hardware or a suitable free compute environment).
5. **Review** — present preview, title, description, tags, thumbnail, and visibility choice. User can request edits.
6. **Stage file** — transfer the finished file directly from the browser/client to temporary object storage using short-lived, scoped authorization. Cloudflare R2 is a candidate, subject to current account limits and cost checks.
7. **YouTube upload** — MCP control plane creates a YouTube resumable upload session and a worker streams bounded chunks from staged storage to YouTube. Persist resumable state and retry safely.
8. **Publish** — default to private/unlisted staging where supported. Change visibility to public or schedule only after explicit approval.
9. **Verify and clean up** — confirm the returned video ID and status, report the YouTube URL, and delete temporary staged media after a retention window or successful verification.

## Implemented planning tools (feature branch)\n\n- `generate_video_script` uses an optional OpenAI-compatible HTTPS chat-completions endpoint configured through Worker environment variables/secrets (`AI_API_URL`, `AI_API_KEY`, `AI_MODEL`). It validates the structured script and stores it in per-user KV with the existing 30-day job retention.\n- `plan_video_scenes` converts that saved script into timed scenes with narration, visual prompts, on-screen text, and transitions. It validates sequential numbering and total duration within 10% of the requested duration before saving.\n- Both tools require the authenticated job owner. If provider settings are absent, they fail clearly without changing job state. No provider is selected or invoked by default; do not add a paid provider or secrets until a free-first provider decision is approved.\n- These tools create text planning artifacts only. They do not generate images, voice, music, subtitles, or rendered video.\n\n## Component boundaries

### A. AI orchestration layer
- Converts natural-language requests into a validated job specification.
- Calls research, script, asset, render, review, and YouTube MCP capabilities.
- Uses provider adapters so a free model or paid model can be selected later.
- Must not claim a video was created or uploaded until the relevant service confirms it.

### B. Media creation / rendering worker
- Runs outside the Cloudflare Worker request lifecycle.
- Handles FFmpeg rendering, audio mixing, subtitle burn-in or sidecar captions, aspect ratios, and preview generation.
- Initially prefer local/user-owned compute or a verified free option; do not assume GitHub-hosted CI is suitable for long or large video renders.
- Emits a final MP4, thumbnail image, metadata manifest, and render logs without secrets.

### C. Cloudflare MCP control plane
- Retains existing OAuth and YouTube management tools.
- Adds job-oriented tools such as create_video_job, get_video_job_status, request_video_revision, prepare_youtube_upload, and finalize_youtube_publish only when their backing services exist.
- Uses short-lived upload credentials and per-user object namespaces.
- Uses KV for small state only; consider Durable Objects or another durable job store if concurrency/coordination requires it.
- Does not proxy entire large files through a single MCP request.

### D. Temporary object storage
- Candidate: Cloudflare R2, with private bucket, scoped keys, short-lived authorization, size/type limits, lifecycle cleanup, and no public bucket access.
- Validate account-level free allowance, request/egress characteristics, multipart behavior, and current pricing before enabling it.
- Never fetch arbitrary user-supplied URLs from the Worker. Prefer direct client-to-storage upload to avoid SSRF and redirect/DNS risks.

### E. YouTube upload adapter
- Uses YouTube Data API resumable uploads.
- Handles session creation, bounded chunk transfer, retry/resume, completion, and status verification.
- Validates media type and size before starting; records upload session state without exposing session URLs to logs.
- Thumbnail upload is a separate API operation with image type and size validation.

## Security and reliability requirements

- Reuse the existing Google OAuth token encryption and refresh flow; request only necessary scopes.
- Treat video scripts, metadata, and assets as untrusted inputs.
- Enforce per-user authorization on every job and object key.
- Use short-lived, single-purpose upload authorization; no public storage ACLs.
- Validate MIME type, file signature where feasible, maximum size, and allowed output formats.
- Do not accept arbitrary remote media URLs in the Worker unless a future allowlist-based fetch design is reviewed.
- Redact OAuth tokens, R2 credentials, signed URLs, and YouTube resumable session URLs from logs and tool responses.
- Add idempotency keys, bounded retries, timeouts, job expiration, and cleanup.
- Require user confirmation for public publishing and destructive actions.
- Respect YouTube API quota, content policies, copyright, music licensing, and AI-generated-content disclosure requirements where applicable.

## Free-first delivery roadmap

### Phase 0 — Architecture and constraints
- Document interfaces, data flow, limits, and threat model.
- Confirm the actual MCP client can pass files or open a browser-based upload flow; do not assume it can attach arbitrary local files to an MCP tool.
- Keep all work on the existing feature branch.

### Phase 1 — Reliable YouTube upload foundation
- Implement and test resumable upload against small controlled test media.
- Add upload status, retries, metadata, privacy handling, and thumbnail upload.
- Use a safe staging mechanism only after account limits and transfer flow are validated.

### Phase 2 — Manual/free rendering path
- Define a portable render manifest and a local FFmpeg-based renderer.
- Generate a small sample video using free/open-source components.
- Validate Marathi Unicode fonts, voiceover alignment, captions, and thumbnail dimensions.

### Phase 3 — AI creation adapters
- Add interchangeable script, voice, image/video asset, and thumbnail providers.
- Start with free/local options where practical; make costs and limitations visible before selecting paid services.

### Phase 4 — End-to-end approval workflow
- Connect brief -> script -> assets -> render -> preview -> staged upload -> YouTube private/unlisted -> explicit publish approval.
- Add job progress and resumability.

### Phase 5 — Scale only after results
- Measure quality, processing time, quota use, storage, and cost per finished video.
- Upgrade only the bottlenecks that demonstrate value.

## Initial implementation decision

Do not add an R2 binding, paid AI provider, or rendering infrastructure just because it appears in this design. First verify the actual file-transfer capability of the intended AI client and the Cloudflare account current free-tier constraints. Implement the smallest secure upload path on the feature branch, then evolve toward the full workflow.