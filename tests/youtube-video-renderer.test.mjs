import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoRendererTools, handleVideoPreviewRequest } from "../src/youtube-video-renderer-tools.ts";

function fakeServer(){const handlers=new Map();return{handlers,registerTool(name,_config,handler){handlers.set(name,handler);}};}
function fakeKv(){const values=new Map();return{values,async get(k){return values.get(k)??null;},async put(k,v){values.set(k,v);}};}
function parse(r){return JSON.parse(r.content[0].text);}
const userId="render-user",jobId="6a7e8d3f-3a12-4b7d-8f41-5e4a2d9c0b11";
function seed(kv){
  kv.values.set(`youtube:video-job:${userId}:${jobId}`,JSON.stringify({jobId,userId,stage:"assets",artifacts:{},updatedAt:new Date().toISOString()}));
  kv.values.set(`youtube:video-media-manifest:${userId}:${jobId}`,JSON.stringify({jobId,aspectRatio:"16:9",voiceoverTracks:[{sceneNumber:1,startSeconds:0,durationSeconds:8,narrationText:"नमस्कार",audioArtifactRef:"kv://audio",imageArtifactRef:"kv://image"}],subtitles:{format:"srt",content:"1\n00:00:00,000 --> 00:00:08,000\nनमस्कार\n"}}));
  kv.values.set(`youtube:video-audio:${userId}:${jobId}:1`,"audio");
  kv.values.set(`youtube:video-image:${userId}:${jobId}:1`,"image");
}
const auth={userId,name:"Test",email:"test@example.com",accessToken:""};
const env={OAUTH_KV:null,MEDIA_BASE_URL:"https://worker.example.test",RENDERER_API_URL:"https://renderer.example.test",RENDERER_API_KEY:"renderer-secret"};

test("renderer tool sends scene assets to async FFmpeg service and polls completion",async()=>{
  const kv=fakeKv();seed(kv);const server=fakeServer();registerVideoRendererTools(server,auth,{...env,OAUTH_KV:kv});
  const originalFetch=globalThis.fetch;let sent;
  globalThis.fetch=async(url,init)=>{
    const target=new URL(url);
    assert.equal(target.origin,env.RENDERER_API_URL);
    assert.equal(new Headers(init.headers).get("Authorization"),"Bearer renderer-secret");
    if(target.pathname==="/render"){sent=JSON.parse(init.body);return new Response(JSON.stringify({jobId,status:"queued"}),{status:202});}
    if(target.pathname===`/jobs/${jobId}`)return new Response(JSON.stringify({status:"preview_ready",byteLength:1234,durationSeconds:8,sceneCount:1,revision:1}),{status:200});
    if(target.pathname===`/preview/${jobId}`&&init.method==="POST")return new Response(JSON.stringify({jobId,status:"rendering"}),{status:202});
    if(target.pathname===`/preview/${jobId}`)return new Response(new Uint8Array([0,0,0,1]),{status:200,headers:{"content-type":"video/mp4"}});
    throw new Error("Unexpected renderer path");
  };
  try{
    const queued=parse(await server.handlers.get("render_video_preview")({jobId}));
    assert.equal(queued.status,"queued");
    assert.equal(sent.manifest.voiceoverTracks[0].audioUrl.startsWith("https://worker.example.test/media/audio/"),true);
    assert.equal(sent.manifest.voiceoverTracks[0].imageUrl.startsWith("https://worker.example.test/media/image/"),true);
    assert.equal(JSON.parse(kv.values.get(`youtube:video-job:${userId}:${jobId}`)).stage,"render");
    const ready=parse(await server.handlers.get("get_video_render_status")({jobId}));
    assert.equal(ready.status,"preview_ready");
    assert.equal(JSON.parse(kv.values.get(`youtube:video-job:${userId}:${jobId}`)).stage,"review");
    const edit=parse(await server.handlers.get("edit_video_subtitles")({jobId,subtitleSrt:"1\n00:00:00,000 --> 00:00:08,000\nनमस्कार पुन्हा\n"}));
    assert.equal(edit.status,"rendering");
    const afterEdit=parse(await server.handlers.get("get_video_render_status")({jobId}));
    assert.equal(afterEdit.status,"preview_ready");
    const link=parse(await server.handlers.get("create_video_preview_link")({jobId}));
    const preview=await handleVideoPreviewRequest(new Request(link.url),{...env,OAUTH_KV:kv});
    assert.equal(preview.status,200);
    assert.equal(preview.headers.get("content-type"),"video/mp4");
  }finally{globalThis.fetch=originalFetch;}
});

test("renderer integration refuses to run when external runtime is not configured",async()=>{
  const kv=fakeKv();seed(kv);const server=fakeServer();
  registerVideoRendererTools(server,auth,{OAUTH_KV:kv,MEDIA_BASE_URL:env.MEDIA_BASE_URL});
  const result=await server.handlers.get("render_video_preview")({jobId});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/External renderer is not configured/);
});


test("renderer tool can queue a single-scene preview from a multi-scene manifest", async () => {
  const kv = fakeKv(); seed(kv);
  const manifestKey = `youtube:video-media-manifest:${userId}:${jobId}`;
  const manifest = JSON.parse(kv.values.get(manifestKey));
  manifest.voiceoverTracks.push({ sceneNumber: 2, startSeconds: 8, durationSeconds: 5, narrationText: "दुसरे दृश्य", audioArtifactRef: "kv://audio-2", imageArtifactRef: "kv://image-2" });
  kv.values.set(manifestKey, JSON.stringify(manifest));
  kv.values.set(`youtube:video-audio:${userId}:${jobId}:2`, "audio-2");
  kv.values.set(`youtube:video-image:${userId}:${jobId}:2`, "image-2");
  const server = fakeServer(); registerVideoRendererTools(server, auth, { ...env, OAUTH_KV: kv });
  const originalFetch = globalThis.fetch; let sent;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === "/render") {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ jobId, status: "queued" }), { status: 202 });
    }
    throw new Error("Unexpected renderer path");
  };
  try {
    const queued = parse(await server.handlers.get("render_video_preview")({ jobId, sceneNumber: 1 }));
    assert.equal(queued.status, "queued");
    assert.equal(sent.manifest.voiceoverTracks.length, 1);
    assert.equal(sent.manifest.voiceoverTracks[0].sceneNumber, 1);
    assert.equal(sent.manifest.voiceoverTracks[0].startSeconds, 0);
    assert.match(sent.manifest.subtitles.content, /नमस्कार/);
    const missing = await server.handlers.get("render_video_preview")({ jobId, sceneNumber: 9 });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /does not exist/);
  } finally { globalThis.fetch = originalFetch; }
});


test("renderer reuses the existing TTS endpoint and shared bearer secret", async () => {
  const kv = fakeKv(); seed(kv); const server = fakeServer();
  registerVideoRendererTools(server, auth, {
    OAUTH_KV: kv,
    MEDIA_BASE_URL: "https://worker.example.test",
    TTS_API_URL: "https://renderer.example.test/v1/audio/speech",
    TTS_API_KEY: "shared-renderer-secret",
  });
  const originalFetch = globalThis.fetch; let target;
  globalThis.fetch = async (url, init) => {
    target = new URL(url);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer shared-renderer-secret");
    return new Response(JSON.stringify({ jobId, status: "queued" }), { status: 202 });
  };
  try {
    const queued = parse(await server.handlers.get("render_video_preview")({ jobId, sceneNumber: 1 }));
    assert.equal(queued.status, "queued");
    assert.equal(target.origin, "https://renderer.example.test");
    assert.equal(target.pathname, "/render");
  } finally { globalThis.fetch = originalFetch; }
});


test("authorized Shorts preview blocks missing human review before calling renderer", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  registerVideoRendererTools(server, auth, { ...env, OAUTH_KV: kv });
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("renderer must not be called"); };
  try {
    const result = await server.handlers.get("render_authorized_shorts_preview")({
      sourceVideoUrl: "https://storage.googleapis.com/rights-cleared/source.mp4",
      startSeconds: 12,
      endSeconds: 42,
      licenseMetadata: "youtube",
      creatorPermissionConfirmed: true,
      thirdPartyAudioCleared: true,
      thirdPartyVisualsCleared: true,
      attributionPlan: "",
      authorizedSourceFileProvided: true,
      humanReviewConfirmed: false,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /human review/);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("authorized Shorts preview sends only reviewed source and returns private preview link", async () => {
  const kv = fakeKv();
  const server = fakeServer();
  registerVideoRendererTools(server, auth, { ...env, OAUTH_KV: kv });
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, env.RENDERER_API_URL);
    assert.equal(target.pathname, "/v1/shorts/preview");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer renderer-secret");
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({
      previewId: "0a7e8d3f-3a12-4b7d-8f41-5e4a2d9c0b11",
      status: "preview_ready",
      durationSeconds: 30,
      byteLength: 45678,
      aspectRatio: "9:16",
      published: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = parse(await server.handlers.get("render_authorized_shorts_preview")({
      sourceVideoUrl: "https://storage.googleapis.com/rights-cleared/source.mp4",
      startSeconds: 12,
      endSeconds: 42,
      subtitlesSrt: "1\\n00:00:00,000 --> 00:00:30,000\\nनमस्कार\\n",
      licenseMetadata: "youtube",
      creatorPermissionConfirmed: true,
      thirdPartyAudioCleared: true,
      thirdPartyVisualsCleared: true,
      attributionPlan: "",
      authorizedSourceFileProvided: true,
      humanReviewConfirmed: true,
    }));
    assert.equal(sent.sourceVideoUrl, "https://storage.googleapis.com/rights-cleared/source.mp4");
    assert.equal(sent.startSeconds, 12);
    assert.equal(sent.endSeconds, 42);
    assert.match(sent.subtitlesSrt, /नमस्कार/);
    assert.equal(result.status, "preview_ready");
    assert.match(result.previewUrl, /^https:\\/\\/worker\\.example\\.test\\/media\\/shorts-preview\\//);
    assert.match(result.rightsReview, /not independently verified/);
    assert.match(result.note, /No YouTube upload/);
    assert.equal([...kv.values.keys()].some(key => key.startsWith("youtube:shorts-preview-grant:")), true);
  } finally { globalThis.fetch = originalFetch; }
});
