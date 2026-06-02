// gestures.js — Hand-gesture classification from MediaPipe Hand landmarks.
//
// Pure, DOM-free functions so they can be unit-tested in Node and reused
// anywhere. Input is the 21-point landmark array produced by MediaPipe's
// HandLandmarker (each point: { x, y, z } in normalized [0,1] image coords).

// ---- Landmark indices (MediaPipe Hands, 21 points) ----
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

// Bones to draw for the hand skeleton overlay.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],            // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],            // index
  [5, 9], [9, 10], [10, 11], [11, 12],       // middle
  [9, 13], [13, 14], [14, 15], [15, 16],     // ring
  [13, 17], [17, 18], [18, 19], [19, 20],    // pinky
  [0, 17],                                   // palm base
];

// Tuning constants (normalized by hand size, so they are scale-invariant).
export const PINCH_ON = 0.5;   // thumb↔index below this (× hand size) → pinch
export const PINCH_OFF = 0.7;  // must exceed this to release (hysteresis)
export const REACH_MIN = 0.85; // index must reach out this far to count as a pinch
                               // (prevents fists from reading as pinches)

const dist = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
};

// Characteristic hand size: wrist → middle-finger knuckle. Used to normalize
// all distance thresholds so they work regardless of distance from the camera.
export function handScale(lm) {
  return dist(lm[LM.WRIST], lm[LM.MIDDLE_MCP]) || 1e-6;
}

// A finger is "extended" when its tip is farther from the wrist than its PIP
// joint. Orientation-independent — works whether the hand points up or sideways.
function extended(lm, tip, pip) {
  return dist(lm[tip], lm[LM.WRIST]) > dist(lm[pip], lm[LM.WRIST]);
}

export function fingerStates(lm) {
  // Thumb moves sideways, so compare its tip vs IP joint distance to the index
  // knuckle instead of to the wrist.
  const thumb =
    dist(lm[LM.THUMB_TIP], lm[LM.INDEX_MCP]) >
    dist(lm[LM.THUMB_IP], lm[LM.INDEX_MCP]);
  return {
    thumb,
    index: extended(lm, LM.INDEX_TIP, LM.INDEX_PIP),
    middle: extended(lm, LM.MIDDLE_TIP, LM.MIDDLE_PIP),
    ring: extended(lm, LM.RING_TIP, LM.RING_PIP),
    pinky: extended(lm, LM.PINKY_TIP, LM.PINKY_PIP),
  };
}

// Distance between thumb tip and index tip, normalized by hand size (0 = touching).
export function pinchAmount(lm) {
  return dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / handScale(lm);
}

/**
 * Classify a single hand into a named gesture.
 * @param {Array<{x,y,z}>} lm        21 landmarks
 * @param {boolean} prevPinch        last frame's pinch state (for hysteresis)
 * @returns {{name, fingers, fingerCount, pinch, indexReach, isPinching}}
 */
export function classify(lm, prevPinch = false) {
  const f = fingerStates(lm);
  const scale = handScale(lm);
  const pinch = dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / scale;
  const indexReach = dist(lm[LM.INDEX_TIP], lm[LM.WRIST]) / scale;
  const count = [f.index, f.middle, f.ring, f.pinky].filter(Boolean).length;

  const threshold = prevPinch ? PINCH_OFF : PINCH_ON;
  const isPinching = pinch < threshold && indexReach > REACH_MIN;

  let name;
  if (isPinching && count <= 1) name = "pinch";
  else if (count === 0) name = "fist";
  else if (f.index && f.middle && !f.ring && !f.pinky) name = "peace";
  else if (f.index && !f.middle && !f.ring && !f.pinky) name = "point";
  else if (count >= 4) name = "open";
  else name = count >= 3 ? "open" : f.index ? "point" : "fist";

  return { name, fingers: f, fingerCount: count, pinch, indexReach, isPinching };
}
