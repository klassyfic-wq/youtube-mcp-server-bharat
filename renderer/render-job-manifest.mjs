export const MAX_INLINE_RENDER_MANIFEST_BYTES = 28 * 1024;

export function encodeRenderManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Render manifest must be an object.");
  }
  const encoded = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
  return Buffer.byteLength(encoded, "utf8") <= MAX_INLINE_RENDER_MANIFEST_BYTES
    ? encoded
    : null;
}

export function decodeRenderManifest(encoded) {
  if (typeof encoded !== "string" || !encoded || encoded.length > MAX_INLINE_RENDER_MANIFEST_BYTES || encoded.length % 4 !== 0) {
    return null;
  }
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return null;
    const manifest = JSON.parse(bytes.toString("utf8"));
    return manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  } catch {
    return null;
  }
}
