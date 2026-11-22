const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

async function safeJson(response, label) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const providerError = payload?.error ?? {};
    const detail = [providerError.status, providerError.message ?? payload?.message]
      .filter(value => typeof value === "string" && value.length)
      .join(": ")
      .replace(/[\\r\\n\\t]+/g, " ")
      .replace(/Bearer\\s+[^\\s,;]+/gi, "Bearer [REDACTED]")
      .slice(0, 500);
    throw new Error(label + " returned HTTP " + response.status + (detail ? " (" + detail + ")." : "."));
  }
  return response.json();
}

export async function generateVertexImage({ projectId, location = "global", model = "gemini-2.5-flash-image", prompt, aspectRatio = "16:9", accessToken, fetchImpl = fetch }) {
  if (!projectId || !accessToken || typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) throw new Error("Invalid Vertex image-generation request.");
  if (!["1:1", "9:16", "16:9"].includes(aspectRatio)) throw new Error("Unsupported image aspect ratio.");
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "x-goog-user-project": projectId },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: 1, imageConfig: { aspectRatio } },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await safeJson(response, "Vertex AI image generation");
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find(part => part.inlineData?.data);
  if (!image || typeof image.inlineData.data !== "string") throw new Error("Vertex AI returned no generated image.");
  const mimeType = image.inlineData.mimeType || "image/png";
  if (!["image/png", "image/jpeg"].includes(mimeType)) throw new Error("Vertex AI returned an unsupported image type.");
  const bytes = Buffer.from(image.inlineData.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Generated image is empty or exceeds the 6 MiB limit.");
  const validPng = mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const validJpeg = mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!validPng && !validJpeg) throw new Error("Vertex AI image bytes do not match the declared PNG/JPEG format.");
  return { base64: bytes.toString("base64"), mimeType, byteLength: bytes.length };
}

export async function synthesizeCloudSpeech({ projectId, text, voiceName = "mr-IN-Chirp3-HD-Achird", accessToken, fetchImpl = fetch }) {
  if (!projectId || !accessToken || typeof text !== "string" || !text.trim() || text.length > 5000) throw new Error("Invalid Cloud Text-to-Speech request.");
  if (!/^mr-IN-(?:Chirp3-HD|Standard|Wavenet)-[A-Za-z0-9]+$/.test(voiceName)) throw new Error("Only configured Marathi (mr-IN) voices are allowed.");
  const languageCode = voiceName.slice(0, 5);
  const response = await fetchImpl("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "x-goog-user-project": projectId },
    body: JSON.stringify({ input: { text }, voice: { languageCode, name: voiceName }, audioConfig: { audioEncoding: "MP3" } }),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await safeJson(response, "Cloud Text-to-Speech");
  if (typeof payload.audioContent !== "string" || !payload.audioContent) throw new Error("Cloud Text-to-Speech returned no audio content.");
  const audio = Buffer.from(payload.audioContent, "base64");
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error("Generated speech is empty or exceeds the 18 MiB limit.");
  return audio;
}
