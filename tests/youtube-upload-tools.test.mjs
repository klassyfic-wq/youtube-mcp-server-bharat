import test from "node:test";
import assert from "node:assert/strict";
import { decodeChunk, nextOffsetFromRange } from "../src/youtube-upload-tools.ts";

test("decodeChunk accepts valid Base64 and returns original bytes", () => {
  const expected = Buffer.from("youtube upload chunk");
  const actual = decodeChunk(expected.toString("base64"));
  assert.deepEqual(Buffer.from(actual), expected);
});

test("decodeChunk rejects malformed Base64", () => {
  assert.throws(() => decodeChunk("not base64!"), /valid standard Base64/);
});

test("decodeChunk rejects empty chunks", () => {
  assert.throws(() => decodeChunk(""), /between 1 byte and 256 KiB/);
});

test("decodeChunk rejects chunks larger than 256 KiB", () => {
  const oversized = Buffer.alloc(256 * 1024 + 1).toString("base64");
  assert.throws(() => decodeChunk(oversized), /between 1 byte and 256 KiB/);
});

test("nextOffsetFromRange converts YouTube inclusive Range to next byte", () => {
  assert.equal(nextOffsetFromRange("bytes=0-262143", 1_000_000), 262144);
});

test("nextOffsetFromRange treats a missing Range as zero bytes uploaded", () => {
  assert.equal(nextOffsetFromRange(null, 1_000_000), 0);
});

test("nextOffsetFromRange rejects malformed ranges", () => {
  assert.throws(() => nextOffsetFromRange("bytes=1-10", 100), /invalid resumable upload range/);
});

test("nextOffsetFromRange rejects offsets beyond declared file size", () => {
  assert.throws(() => nextOffsetFromRange("bytes=0-100", 100), /outside the declared file size/);
});
