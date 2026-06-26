import assert from "node:assert/strict";
import test from "node:test";
import { selectPullTarget } from "../../src/lib/pull-target";

test("selectPullTarget returns null for empty list", () => {
  assert.equal(selectPullTarget([]), null);
});

test("selectPullTarget picks the most free VRAM", () => {
  const best = selectPullTarget([
    { name: "a", freeVramBytes: 100 },
    { name: "b", freeVramBytes: 300 },
    { name: "c", freeVramBytes: 200 },
  ]);
  assert.equal(best?.name, "b");
});

test("selectPullTarget returns the single candidate", () => {
  assert.equal(selectPullTarget([{ name: "solo", freeVramBytes: 5 }])?.name, "solo");
});
