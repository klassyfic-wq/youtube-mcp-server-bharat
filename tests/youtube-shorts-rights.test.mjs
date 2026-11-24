import test from "node:test";
import assert from "node:assert/strict";
import { registerYoutubeShortsRightsTools } from "../src/youtube-shorts-rights-tools.ts";

function fakeServer() {
  const handlers = new Map();
  return { handlers, registerTool(name, _config, handler) { handlers.set(name, handler); } };
}

test("Creative Commons metadata alone does not clear third-party rights or authorize editing", async () => {
  const server = fakeServer();
  registerYoutubeShortsRightsTools(server);
  const response = await server.handlers.get("evaluate_short_source_rights")({
    videoId: "abcdefghijk",
    licenseMetadata: "creativeCommon",
    creatorPermissionConfirmed: false,
    thirdPartyAudioCleared: false,
    thirdPartyVisualsCleared: true,
    attributionPlan: "Credit the creator and link to the source.",
    authorizedSourceFileProvided: true,
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.decision, "blocked");
  assert.equal(data.mayProceedToShortsPreview, false);
  assert.match(data.blockers.join(" "), /Third-party audio rights are not confirmed/);
  assert.match(data.verification, /not independently verified/);
});

test("standard licence requires creator permission and all source-rights attestations", async () => {
  const server = fakeServer();
  registerYoutubeShortsRightsTools(server);
  const response = await server.handlers.get("evaluate_short_source_rights")({
    videoId: "abcdefghijk",
    licenseMetadata: "youtube",
    creatorPermissionConfirmed: true,
    thirdPartyAudioCleared: true,
    thirdPartyVisualsCleared: true,
    attributionPlan: "",
    authorizedSourceFileProvided: true,
    humanReviewConfirmed: false,
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.decision, "attestations_complete_pending_human_review");
  assert.equal(data.mayProceedToShortsPreview, false);
  assert.match(data.blockers[0], /Human review/);
});


test("all rights attestations plus human review approve preview but do not publish", async () => {
  const server = fakeServer();
  registerYoutubeShortsRightsTools(server);
  const response = await server.handlers.get("evaluate_short_source_rights")({
    videoId: "abcdefghijk",
    licenseMetadata: "youtube",
    creatorPermissionConfirmed: true,
    thirdPartyAudioCleared: true,
    thirdPartyVisualsCleared: true,
    attributionPlan: "",
    authorizedSourceFileProvided: true,
    humanReviewConfirmed: true,
  });
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.decision, "approved_for_preview");
  assert.equal(data.mayProceedToShortsPreview, true);
  assert.deepEqual(data.blockers, []);
  assert.match(data.nextAction, /render_authorized_shorts_preview/);
});
