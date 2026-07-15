import assert from "node:assert/strict";
import test from "node:test";
import {
  proofMediaUrlsFromContextForTest,
  proofVideoUrlsFromContextForTest,
} from "../dist/clawsweeper.js";

// Regression for openclaw/clawsweeper#594: linked screenshot proof was never
// hydrated into proofScratchDir (only videos were), so the read-only reviewer
// (networkAccess:false) could not view it and rated realBehaviorProof insufficient
// no matter how good the screenshots were. Image proof URLs must now be collected
// for hydration exactly like videos.

const IMG = "https://github.com/user/repo/releases/download/proof/screenshot.png";
const VID = "https://github.com/user/repo/releases/download/proof/demo.mov";

const ctx = (url: string) => ({
  issue: {},
  comments: [{ body: `proof: ![shot](${url})` }],
  timeline: [],
});

test("#594: a linked screenshot (.png) is collected as image media proof", () => {
  const media = proofMediaUrlsFromContextForTest(ctx(IMG) as never);
  assert.deepEqual(media, [{ url: IMG, kind: "image" }]);
});

test("#594 control: a linked video (.mov) is still collected as video media proof", () => {
  const media = proofMediaUrlsFromContextForTest(ctx(VID) as never);
  assert.deepEqual(media, [{ url: VID, kind: "video" }]);
});

test("#594: both screenshot and video in one PR are collected", () => {
  const both = {
    issue: {},
    comments: [{ body: `proof: ![shot](${IMG}) and video ${VID}` }],
    timeline: [],
  };
  const media = proofMediaUrlsFromContextForTest(both as never);
  assert.deepEqual(new Set(media.map((m) => m.kind)), new Set(["image", "video"]));
});

test("#594: the video-only hook is unchanged — it excludes images, keeps videos", () => {
  // Preserves existing behavior for callers/tests that care specifically about video.
  assert.deepEqual(proofVideoUrlsFromContextForTest(ctx(VID) as never), [VID]);
  assert.deepEqual(proofVideoUrlsFromContextForTest(ctx(IMG) as never), []);
});
