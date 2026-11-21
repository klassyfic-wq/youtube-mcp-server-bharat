import test from "node:test";
import assert from "node:assert/strict";
import { registerVideoRendererTools, handleVideoPreviewRequest } from "../src/youtube-video-renderer-tools.ts";

function fakeServer(){const handlers=new Map();return{handlers,registerTool(name,_config,handler){handlers.set(name,handler);}};}
function fakeKv(){const values=new Map();return{values,async get(k){return values.get(k)??null;},async put(k,v){values.set(k,v);}};}
function parse(r){return JSON.parse(r.content[0].text);}
const userId="render-user",jobId="6a7e8d3f-3a12-4b7d-8f41-5e4a2d9c0b11";
function seed(kv){
  kv.values.set(`youtube:video-job:${userId}:${jobId}`,JSON.stringify({jobId,userId,stage:"assets",artifacts:{},updatedAt:new Date().toISOString()}));
  kv.values.set(`youtube:video-media-manifest:${userId}:${jobId}`,JSON.stringify({jobId,aspectRatio:"16:9",voiceoverTracks:[{sceneNumber:1,startSeconds:0,durationSeconds:8,audioArtifactRef:"kv://audio",imageArtifactRef:"kv://image"}],subtitles:{format:"srt",content:"1\n00:00:00,000 --> 00:00:08,000\nनमस्कार\n"}}));
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
