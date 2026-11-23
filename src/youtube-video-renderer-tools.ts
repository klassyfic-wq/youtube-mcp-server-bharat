import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./utils.ts";

type RendererEnv = Env & {
  MEDIA_BASE_URL?: string;
  RENDERER_API_URL?: string;
  RENDERER_API_KEY?: string;
  TTS_API_URL?: string;
  TTS_API_KEY?: string;
};
type Job = { jobId: string; userId: string; stage: string; artifacts: Record<string,string>; updatedAt: string };
type Track = { sceneNumber: number; startSeconds: number; durationSeconds: number; audioArtifactRef?: string; imageArtifactRef?: string; [key: string]: unknown };
type Manifest = { jobId: string; aspectRatio: string; voiceoverTracks: Track[]; subtitles: { format: string; content: string }; [key: string]: unknown };
const jobKey = (u:string,j:string)=>`youtube:video-job:${u}:${j}`;
const manifestKey = (u:string,j:string)=>`youtube:video-media-manifest:${u}:${j}`;
const audioKey = (u:string,j:string,n:number)=>`youtube:video-audio:${u}:${j}:${n}`;
const imageKey = (u:string,j:string,n:number)=>`youtube:video-image:${u}:${j}:${n}`;
const previewGrantKey = (t:string)=>`youtube:video-preview-grant:${t}`;
const audioGrantKey = (t:string)=>`youtube:audio-download-grant:${t}`;
const imageGrantKey = (t:string)=>`youtube:image-download-grant:${t}`;
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
function formatSrtTime(seconds:number){const ms=Math.max(0,Math.round(seconds*1000));const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),milli=ms%1000;return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(milli).padStart(3,"0")}`;}
function response(v:unknown){return{content:[{type:"text" as const,text:JSON.stringify(v,null,2)}]};}
function failure(e:unknown){console.error("Video renderer request failed:",e instanceof Error?e.message:"unknown error");return{content:[{type:"text" as const,text:e instanceof Error?e.message:"Video renderer request failed."}],isError:true};}
async function rendererFailure(response:Response,context:string):Promise<Error>{
  const raw=await response.text().catch(()=>"");
  let payload:Record<string,unknown>={};
  try{const parsed=JSON.parse(raw.slice(0,8192));if(parsed&&typeof parsed==="object")payload=parsed as Record<string,unknown>;}catch{}
  const rawMessage=typeof payload.error==="string"?payload.error:typeof payload.message==="string"?payload.message:raw;
  const safeMessage=rawMessage
    .replace(/https?:\/\/[^\s"'<>]+/gi,"[redacted-url]")
    .replace(/Bearer\s+[^\s"'<>]+/gi,"Bearer [redacted]")
    .replace(/(?:token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,"[redacted]")
    .slice(0,500)
    .trim();
  const headerRequestId=response.headers.get("x-request-id");
  const bodyRequestId=typeof payload.requestId==="string"&&/^[a-zA-Z0-9-]{1,80}$/.test(payload.requestId)?payload.requestId:null;
  const requestId=bodyRequestId??(headerRequestId&&/^[a-zA-Z0-9-]{1,80}$/.test(headerRequestId)?headerRequestId:null);
  return new Error(`${context} HTTP ${response.status}${safeMessage?`: ${safeMessage}`:""}${requestId?` (requestId: ${requestId})`:""}.`);
}
function rendererApiKey(env:RendererEnv):string{
  const key=env.RENDERER_API_KEY??env.TTS_API_KEY;
  if(!key)throw new Error("External renderer is not configured. Set RENDERER_API_KEY or the shared TTS_API_KEY secret.");
  return key;
}
function rendererBase(env:RendererEnv):URL{
  let configuredUrl=env.RENDERER_API_URL;
  if(!configuredUrl&&env.TTS_API_URL){
    const ttsUrl=new URL(env.TTS_API_URL);
    if(ttsUrl.protocol!=="https:"||ttsUrl.username||ttsUrl.password||ttsUrl.search||ttsUrl.hash)throw new Error("TTS_API_URL must be a clean HTTPS endpoint before it can be reused for rendering.");
    configuredUrl=ttsUrl.origin;
  }
  if(!configuredUrl)throw new Error("External renderer is not configured. Set RENDERER_API_URL or the shared TTS_API_URL variable.");
  const u=new URL(configuredUrl);
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw new Error("RENDERER_API_URL must be a clean HTTPS base URL.");
  rendererApiKey(env);
  return u;
}
function mediaBase(env:RendererEnv):URL{
  if(!env.MEDIA_BASE_URL)throw new Error("MEDIA_BASE_URL is not configured.");
  const u=new URL(env.MEDIA_BASE_URL);
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash)throw new Error("MEDIA_BASE_URL must be a clean HTTPS URL.");
  return u;
}
export async function handleVideoPreviewRequest(request:Request,env:RendererEnv):Promise<Response>{
  const headers={"Cache-Control":"private, no-store, max-age=0","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
  if(request.method!=="GET")return new Response("Method not allowed",{status:405,headers:{...headers,Allow:"GET"}});
  const m=new URL(request.url).pathname.match(/^\/media\/preview\/([a-f0-9]{64})$/);
  if(!m)return new Response("Not found",{status:404,headers});
  try{
    const raw=await env.OAUTH_KV.get(previewGrantKey(m[1]));
    if(!raw)return new Response("Preview link is invalid or expired.",{status:404,headers});
    const grant=JSON.parse(raw) as {userId:string;jobId:string;expiresAt:number};
    if(!grant.userId||!grant.jobId||grant.expiresAt<=Date.now())return new Response("Preview link is invalid or expired.",{status:404,headers});
    const base=rendererBase(env);
    const upstream=await fetch(new URL(`/preview/${grant.jobId}`,base),{headers:{Authorization:`Bearer ${rendererApiKey(env)}`},signal:AbortSignal.timeout(120_000)});
    if(!upstream.ok)return new Response("Preview is not available from the renderer.",{status:upstream.status===404?404:502,headers});
    const contentType=upstream.headers.get("content-type");
    if(contentType!=="video/mp4")return new Response("Renderer returned an unexpected preview type.",{status:502,headers});
    return new Response(upstream.body,{status:200,headers:{...headers,"Content-Type":"video/mp4","Content-Disposition":`inline; filename="${grant.jobId}-preview.mp4"`,...(upstream.headers.get("content-length")?{"Content-Length":upstream.headers.get("content-length")!}:{})}});
  }catch(e){console.error("Preview proxy failed:",e instanceof Error?e.message:"unknown error");return new Response("Unable to retrieve preview.",{status:502,headers});}
}
export function registerVideoRendererTools(server:McpServer,authProps:Props|undefined,env:RendererEnv){
  server.registerTool("render_video_preview",{
    description:"Send a complete scene manifest and short-lived private audio/image links to the configured external FFmpeg renderer. Creates a preview only; it does not upload or publish to YouTube.",
    inputSchema:{jobId:z.string().uuid(),sceneNumber:z.number().int().positive().optional()},
  },async({jobId,sceneNumber})=>{
    try{
      const userId=authProps?.userId;if(!userId)throw new Error("Authentication required.");
      const rawJob=await env.OAUTH_KV.get(jobKey(userId,jobId));if(!rawJob)throw new Error("Video job not found or expired.");
      const job=JSON.parse(rawJob) as Job;if(job.userId!==userId)throw new Error("Video job does not belong to this account.");
      if(job.stage!=="assets"&&job.stage!=="render")throw new Error("Rendering requires a job at assets or render stage.");
      const raw=await env.OAUTH_KV.get(manifestKey(userId,jobId));if(!raw)throw new Error("Media manifest not found.");
      const manifest=JSON.parse(raw) as Manifest;if(manifest.jobId!==jobId||!Array.isArray(manifest.voiceoverTracks)||!manifest.voiceoverTracks.length)throw new Error("Media manifest is invalid.");
      const base=mediaBase(env);const now=Date.now();const tracks=[];
      const selectedTracks = sceneNumber === undefined ? manifest.voiceoverTracks : manifest.voiceoverTracks.filter((track) => track.sceneNumber === sceneNumber);
      if (!selectedTracks.length) throw new Error(sceneNumber === undefined ? "Media manifest contains no scenes." : `Scene ${sceneNumber} does not exist in the media manifest.`);
      for(const sourceTrack of selectedTracks){
        const track = sceneNumber === undefined ? sourceTrack : { ...sourceTrack, startSeconds: 0 };
        if(!track.audioArtifactRef||!track.imageArtifactRef)throw new Error(`Scene ${track.sceneNumber} needs both generated voiceover and image before rendering.`);
        const akey=audioKey(userId,jobId,track.sceneNumber), ikey=imageKey(userId,jobId,track.sceneNumber);
        if(!await env.OAUTH_KV.get(akey)||!await env.OAUTH_KV.get(ikey))throw new Error(`Scene ${track.sceneNumber} media artifact is missing.`);
        const at=randomToken(),it=randomToken();
        await Promise.all([
          env.OAUTH_KV.put(audioGrantKey(at),JSON.stringify({audioKey:akey,userId,jobId,sceneNumber:track.sceneNumber,expiresAt:now+1800000}),{expirationTtl:1800}),
          env.OAUTH_KV.put(imageGrantKey(it),JSON.stringify({imageKey:ikey,userId,jobId,sceneNumber:track.sceneNumber,expiresAt:now+1800000}),{expirationTtl:1800}),
        ]);
        tracks.push({...track,audioUrl:new URL(`/media/audio/${at}`,base).toString(),imageUrl:new URL(`/media/image/${it}`,base).toString()});
      }
      const endpoint=rendererBase(env);
      const selectedTrack = selectedTracks[0];
      const renderManifest={
        ...manifest,
        voiceoverTracks:tracks,
        ...(sceneNumber === undefined ? {} : { subtitles: { format: "srt", content: `1\n00:00:00,000 --> ${formatSrtTime(selectedTrack.durationSeconds)}\n${String(selectedTrack.narrationText ?? "").trim()}\n` } }),
      };
      const upstream=await fetch(new URL("/render",endpoint),{method:"POST",headers:{Authorization:`Bearer ${rendererApiKey(env)}`,"Content-Type":"application/json"},body:JSON.stringify({jobId,manifest:renderManifest}),signal:AbortSignal.timeout(30_000)});
      if(upstream.status!==202)throw await rendererFailure(upstream,"External renderer returned");
      const result=await upstream.json() as Record<string,unknown>;
      job.stage="render";job.artifacts={...job.artifacts,videoPreview:`renderer://${jobId}`};job.updatedAt=new Date().toISOString();
      await env.OAUTH_KV.put(jobKey(userId,jobId),JSON.stringify(job),{expirationTtl:30*24*60*60});
      return response({jobId,status:"queued",rendererResult:result,note:"Rendering runs asynchronously. Call get_video_render_status until status is preview_ready; YouTube upload and publishing have not been performed."});
    }catch(e){return failure(e);}
  });

  server.registerTool("get_video_render_status",{
    description:"Poll the external FFmpeg renderer for a job's queued/rendering/preview_ready/failed status. Moves the job to review only after the renderer confirms a ready preview.",
    inputSchema:{jobId:z.string().uuid()},
  },async({jobId})=>{
    try{
      const userId=authProps?.userId;if(!userId)throw new Error("Authentication required.");
      const raw=await env.OAUTH_KV.get(jobKey(userId,jobId));if(!raw)throw new Error("Video job not found or expired.");
      const job=JSON.parse(raw) as Job;if(job.userId!==userId)throw new Error("Video job does not belong to this account.");
      if(job.stage!=="render"&&job.stage!=="review")throw new Error("Video job is not in the render/review stage.");
      const base=rendererBase(env);
      const upstream=await fetch(new URL(`/jobs/${jobId}`,base),{headers:{Authorization:`Bearer ${rendererApiKey(env)}`},signal:AbortSignal.timeout(30_000)});
      if(!upstream.ok)throw new Error(`Renderer status API returned HTTP ${upstream.status}.`);
      const status=await upstream.json() as {status?:string;error?:string;previewPath?:string;byteLength?:number;durationSeconds?:number;sceneCount?:number;revision?:number};
      if(status.status==="preview_ready"){
        job.stage="review";job.updatedAt=new Date().toISOString();
        job.artifacts={...job.artifacts,videoPreview:`renderer://${jobId}`};
        await env.OAUTH_KV.put(jobKey(userId,jobId),JSON.stringify(job),{expirationTtl:30*24*60*60});
      }
      if(status.status==="failed")throw new Error(status.error??"External FFmpeg render failed.");
      return response({jobId,status:status.status??"unknown",stage:job.stage,byteLength:status.byteLength,durationSeconds:status.durationSeconds,sceneCount:status.sceneCount,revision:status.revision,note:status.status==="preview_ready"?"Preview is ready for review. Call create_video_preview_link to watch it.": "Rendering is still in progress."});
    }catch(e){return failure(e);}
  });

  server.registerTool("edit_video_subtitles",{
    description:"Submit revised SRT subtitle text for an existing preview and queue an FFmpeg re-render. This initial editing workflow supports subtitle changes only.",
    inputSchema:{jobId:z.string().uuid(),subtitleSrt:z.string().min(1).max(200000)},
  },async({jobId,subtitleSrt})=>{
    try{
      const userId=authProps?.userId;if(!userId)throw new Error("Authentication required.");
      const raw=await env.OAUTH_KV.get(jobKey(userId,jobId));if(!raw)throw new Error("Video job not found or expired.");
      const job=JSON.parse(raw) as Job;if(job.userId!==userId||job.stage!=="review")throw new Error("A rendered preview for this account is required before editing.");
      const base=rendererBase(env);
      const upstream=await fetch(new URL(`/preview/${jobId}`,base),{method:"POST",headers:{Authorization:`Bearer ${rendererApiKey(env)}`,"Content-Type":"application/json"},body:JSON.stringify({edits:{subtitleSrt}}),signal:AbortSignal.timeout(30_000)});
      if(upstream.status!==202)throw await rendererFailure(upstream,"Renderer edit endpoint returned");
      const result=await upstream.json() as Record<string,unknown>;
      job.stage="render";job.updatedAt=new Date().toISOString();
      await env.OAUTH_KV.put(jobKey(userId,jobId),JSON.stringify(job),{expirationTtl:30*24*60*60});
      return response({jobId,status:"rendering",rendererResult:result,note:"Subtitle revision queued. Poll get_video_render_status before opening the updated preview."});
    }catch(e){return failure(e);}
  });

  server.registerTool("create_video_preview_link",{
    description:"Issue a short-lived private preview URL for the rendered MP4. Treat the URL as a bearer secret.",
    inputSchema:{jobId:z.string().uuid()},
  },async({jobId})=>{
    try{
      const userId=authProps?.userId;if(!userId)throw new Error("Authentication required.");
      const raw=await env.OAUTH_KV.get(jobKey(userId,jobId));if(!raw)throw new Error("Video job not found or expired.");
      const job=JSON.parse(raw) as Job;if(job.userId!==userId||job.stage!=="review")throw new Error("A rendered preview for this account was not found.");
      const base=mediaBase(env);rendererBase(env);
      const token=randomToken(),expiresAt=Date.now()+10*60*1000;
      await env.OAUTH_KV.put(previewGrantKey(token),JSON.stringify({userId,jobId,expiresAt}),{expirationTtl:600});
      return response({jobId,url:new URL(`/media/preview/${token}`,base).toString(),expiresAt:new Date(expiresAt).toISOString(),expiresInSeconds:600,note:"Private preview link; no YouTube upload or publication has occurred."});
    }catch(e){return failure(e);}
  });
}
