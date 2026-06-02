import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, fingerStates, pinchAmount } from "../js/gestures.js";

// Build a synthetic 21-point hand. Fingers point "up" (smaller y = farther out).
// Extended fingers reach toward y≈0.46; curled fingers tuck toward the wrist.
function hand({
  thumb = true,
  index = true,
  middle = true,
  ring = true,
  pinky = true,
  pinch = false,
} = {}) {
  const wrist = { x: 0.5, y: 0.95, z: 0 };
  const colX = { index: 0.44, middle: 0.5, ring: 0.56, pinky: 0.64 };
  const lm = new Array(21);
  lm[0] = wrist;

  const setFinger = (base, x, ext) => {
    lm[base] = { x, y: 0.72, z: 0 }; // MCP knuckle
    if (ext) {
      lm[base + 1] = { x, y: 0.62, z: 0 };
      lm[base + 2] = { x, y: 0.54, z: 0 };
      lm[base + 3] = { x, y: 0.46, z: 0 };
    } else {
      lm[base + 1] = { x, y: 0.67, z: 0 };
      lm[base + 2] = { x, y: 0.73, z: 0 };
      lm[base + 3] = { x, y: 0.8, z: 0 }; // tip tucked back toward palm
    }
  };
  setFinger(5, colX.index, index);
  setFinger(9, colX.middle, middle);
  setFinger(13, colX.ring, ring);
  setFinger(17, colX.pinky, pinky);

  if (thumb) {
    lm[1] = { x: 0.42, y: 0.86, z: 0 };
    lm[2] = { x: 0.36, y: 0.78, z: 0 };
    lm[3] = { x: 0.31, y: 0.7, z: 0 };
    lm[4] = { x: 0.27, y: 0.62, z: 0 };
  } else {
    lm[1] = { x: 0.44, y: 0.86, z: 0 };
    lm[2] = { x: 0.46, y: 0.8, z: 0 };
    lm[3] = { x: 0.47, y: 0.74, z: 0 };
    lm[4] = { x: 0.48, y: 0.7, z: 0 };
  }

  for (const p of lm) if (p.z === undefined) p.z = 0;

  // A real pinch brings the thumb tip onto the (extended) index tip.
  if (pinch) lm[4] = { x: lm[8].x, y: lm[8].y, z: 0 };
  return lm;
}

test("finger states detect extension", () => {
  const f = fingerStates(hand({ index: true, middle: false, ring: false, pinky: false }));
  assert.equal(f.index, true);
  assert.equal(f.middle, false);
  assert.equal(f.ring, false);
  assert.equal(f.pinky, false);
});

test("open palm", () => {
  const g = classify(hand());
  assert.equal(g.name, "open");
  assert.equal(g.isPinching, false);
});

test("fist", () => {
  const g = classify(
    hand({ thumb: false, index: false, middle: false, ring: false, pinky: false })
  );
  assert.equal(g.name, "fist");
  assert.equal(g.isPinching, false);
});

test("point", () => {
  const g = classify(hand({ index: true, middle: false, ring: false, pinky: false }));
  assert.equal(g.name, "point");
});

test("peace", () => {
  const g = classify(hand({ index: true, middle: true, ring: false, pinky: false }));
  assert.equal(g.name, "peace");
});

test("pinch", () => {
  const g = classify(
    hand({ index: true, middle: false, ring: false, pinky: false, pinch: true })
  );
  assert.equal(g.isPinching, true);
  assert.equal(g.name, "pinch");
  assert.ok(pinchAmount(hand({ pinch: true })) < 0.1);
});

test("pinch hysteresis keeps holding through a small gap", () => {
  // A hand midway between pinched and open should stay pinched if it already was.
  const lm = hand({ index: true, middle: false, ring: false, pinky: false });
  lm[4] = { x: lm[8].x + 0.1, y: lm[8].y + 0.1, z: 0 }; // ~0.61 of hand size apart
  assert.equal(classify(lm, false).isPinching, false); // wouldn't start a pinch
  assert.equal(classify(lm, true).isPinching, true); //   but holds an existing one
});
