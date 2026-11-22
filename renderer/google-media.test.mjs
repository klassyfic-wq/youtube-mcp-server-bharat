import test from "node:test";
import assert from "node:assert/strict";
import { generateVertexImage, synthesizeCloudSpeech } from "./google-media.mjs";

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString("base64");

test("Vertex image adapter sends bounded prompt and returns validated PNG", async () => {
  let request;
  const result = await generateVertexImage({
    projectId: "demo-project", prompt: "A cinematic technology scene", aspectRatio: "16:9", accessToken: "test-token",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body), headers: new Headers(init.headers) };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }), { status: 200 });
    },
  });
  assert.match(request.url, /locations\/global\/publishers\/google\/models\/gemini-2.5-flash-image:generateContent$/);
  assert.equal(request.headers.get("authorization"), "Bearer test-token");
  assert.equal(request.body.generationConfig.imageConfig.aspectRatio, "16:9");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.base64, png);
});

test("Vertex image adapter retains a bounded provider 400 message", async () => {
  await assert.rejects(() => generateVertexImage({
    projectId: "p", prompt: "x", accessToken: "t",
    fetchImpl: async () => new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid imageConfig aspectRatio." } }), { status: 400 }),
  }), /HTTP 400 .*INVALID_ARGUMENT/);
});

test("Vertex image adapter rejects unsupported ratios and malformed output", async () => {
  await assert.rejects(() => generateVertexImage({ projectId: "p", prompt: "x", aspectRatio: "4:3", accessToken: "t" }), /Unsupported image aspect ratio/);
  await assert.rejects(() => generateVertexImage({
    projectId: "p", prompt: "x", accessToken: "t",
    fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("not png").toString("base64") } }] } }] }), { status: 200 }),
  }), /do not match/);
});

test("Cloud TTS adapter requests Marathi Chirp 3 HD MP3 and returns audio bytes", async () => {
  let request;
  const audioBase64 = Buffer.from([0x49,0x44,0x33,1,2,3]).toString("base64");
  const audio = await synthesizeCloudSpeech({
    projectId: "demo-project", text: "नमस्कार!", voiceName: "mr-IN-Chirp3-HD-Achird", accessToken: "test-token",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body), headers: new Headers(init.headers) };
      return new Response(JSON.stringify({ audioContent: audioBase64 }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.equal(request.body.voice.languageCode, "mr-IN");
  assert.equal(request.body.voice.name, "mr-IN-Chirp3-HD-Achird");
  assert.equal(request.body.audioConfig.audioEncoding, "MP3");
  assert.deepEqual(audio, Buffer.from([0x49,0x44,0x33,1,2,3]));
});

test("Cloud TTS adapter refuses non-Marathi voice IDs", async () => {
  await assert.rejects(() => synthesizeCloudSpeech({ projectId: "p", text: "hello", voiceName: "en-US-Chirp3-HD-Achird", accessToken: "t" }), /Only configured Marathi/);
});
