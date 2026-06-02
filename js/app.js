// app.js — GestureLab main application.
//
// Wires a webcam + MediaPipe HandLandmarker to an interactive page you can
// drive with hand gestures:
//   👉 point  → move a cursor          🤏 pinch → grab & drag cards / draw
//   ✌️ peace  → toggle draw mode        ✊ fist  → reset the scene
// Falls back to mouse control when no camera is available.

import { classify, LM, HAND_CONNECTIONS } from "./gestures.js";

// MediaPipe Tasks-Vision is loaded on demand (see initModel) rather than as a
// top-level static import, so the page still works in mouse mode even if the
// CDN is unreachable — only camera mode needs the network. Mirror CDNs are
// tried in order; the bare package URL is the form documented by MediaPipe.
const VISION_CDNS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.14",
];
const MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ---------- config ----------
const NUM_HANDS = 2;
const GAIN = 1.3; // amplify hand motion so you can reach screen edges easily
const SMOOTH = 0.4; // cursor smoothing (0..1, higher = snappier)
const STABLE_FRAMES = 12; // hold a gesture this long before it triggers an action
const HAND_COLORS = ["#36e2ff", "#ff4dd8"];
const CARD_DATA = [
  { icon: "🚀", label: "火箭" },
  { icon: "🎵", label: "音乐" },
  { icon: "🌈", label: "彩虹" },
  { icon: "💡", label: "灵感" },
  { icon: "📷", label: "照片" },
  { icon: "⭐", label: "星星" },
];
const GESTURE_LABEL = {
  pinch: "🤏 捏",
  fist: "✊ 拳",
  open: "🖐 张开",
  peace: "✌️ 比耶",
  point: "👉 指",
};

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const dom = {
  start: $("#startScreen"),
  btnCamera: $("#btnCamera"),
  btnMouse: $("#btnMouse"),
  loading: $("#loading"),
  error: $("#startError"),
  scene: $("#scene"),
  pointers: $("#pointers"),
  draw: $("#drawCanvas"),
  fx: $("#fxCanvas"),
  video: $("#camVideo"),
  overlay: $("#camOverlay"),
  preview: $("#previewPanel"),
  modeChip: $("#modeChip"),
  zoomChip: $("#zoomChip"),
  handsChip: $("#handsChip"),
  fpsChip: $("#fpsChip"),
  gestureChips: $("#gestureChips"),
  guide: $("#guide"),
  guideToggle: $("#guideToggle"),
  btnMode: $("#btnMode"),
  btnReset: $("#btnReset"),
};
const dctx = dom.draw.getContext("2d");
const fxctx = dom.fx.getContext("2d");
const octx = dom.overlay.getContext("2d");

// ---------- state ----------
let landmarker = null;
let useCamera = false;
let running = false;
let mode = "drag"; // "drag" | "draw"
let lastTime = performance.now();
let fps = 0;
let lastVideoTime = -1;
let lastResults = null;
const pointers = [];
const cards = [];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Scene view transform for two-hand pinch zoom/pan. "world" = scene coords,
// "screen" = pixels. At scale 1 / offset 0 they are identical, so single-hand
// behavior is unchanged when not zoomed.
const view = { scale: 1, x: 0, y: 0 };
let zoom = null; // active two-hand pinch session, or null
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const toWorld = (sx, sy) => ({
  x: (sx - view.x) / view.scale,
  y: (sy - view.y) / view.scale,
});
function applyView() {
  dom.scene.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

// ---------- pointer (one per hand / mouse) ----------
class Pointer {
  constructor(id, color) {
    this.id = id;
    this.color = color;
    this.el = document.createElement("div");
    this.el.className = "pointer hidden";
    this.el.style.setProperty("--c", color);
    this.label = document.createElement("span");
    this.label.className = "pointer-label";
    this.el.appendChild(this.label);
    dom.pointers.appendChild(this.el);

    this.x = innerWidth / 2;
    this.y = innerHeight / 2;
    this.tx = this.x;
    this.ty = this.y;
    this.visible = false;
    this.pinch = false;
    this.gesture = "—";
    this.grab = null; // grabbed card
    this.ox = 0;
    this.oy = 0;
    this.stroke = null; // {x,y} last draw point
    this.trail = [];
    this._lastName = "";
    this._hold = 0;
  }

  setTarget(x, y) {
    this.tx = x;
    this.ty = y;
  }

  update() {
    this.x = lerp(this.x, this.tx, SMOOTH);
    this.y = lerp(this.y, this.ty, SMOOTH);
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    this.el.classList.toggle("hidden", !this.visible);
    this.el.classList.toggle("pinching", this.pinch);
    this.label.textContent = this.visible ? this.gesture : "";

    if (this.visible) this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 22) this.trail.shift();
    if (!this.visible && this.trail.length) this.trail.shift();
  }
}

// ---------- card (draggable object) ----------
class Card {
  constructor(data, x, y) {
    this.el = document.createElement("div");
    this.el.className = "card";
    this.el.innerHTML = `<div class="card-icon">${data.icon}</div><div class="card-label">${data.label}</div>`;
    dom.scene.appendChild(this.el);
    this.w = 120;
    this.h = 120;
    this.homeX = x;
    this.homeY = y;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.bob = Math.random() * Math.PI * 2;
    this.grabbedBy = null;
  }

  contains(px, py) {
    return px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h;
  }

  update(dt) {
    if (!this.grabbedBy) {
      this.x += this.vx;
      this.y += this.vy;
      this.vx *= 0.92;
      this.vy *= 0.92;
      const maxX = innerWidth - this.w;
      const maxY = innerHeight - this.h;
      if (this.x < 0) { this.x = 0; this.vx *= -0.5; }
      if (this.x > maxX) { this.x = maxX; this.vx *= -0.5; }
      if (this.y < 0) { this.y = 0; this.vy *= -0.5; }
      if (this.y > maxY) { this.y = maxY; this.vy *= -0.5; }
      this.bob += dt * 0.002;
    }
    const bobY = this.grabbedBy ? 0 : Math.sin(this.bob) * 6;
    this.el.style.transform = `translate(${this.x}px, ${this.y + bobY}px)`;
    this.el.classList.toggle("grabbed", !!this.grabbedBy);
  }

  goHome() {
    this.x = this.homeX;
    this.y = this.homeY;
    this.vx = this.vy = 0;
  }
}

// ---------- scene setup ----------
function buildScene() {
  const cols = Math.min(CARD_DATA.length, 3);
  const gapX = innerWidth / (cols + 1);
  const rows = Math.ceil(CARD_DATA.length / cols);
  CARD_DATA.forEach((d, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = gapX * (c + 1) - 60 + (Math.random() * 40 - 20);
    const y = innerHeight * (0.34 + (r / Math.max(rows, 1)) * 0.32) - 60;
    cards.push(new Card(d, clamp(x, 10, innerWidth - 130), clamp(y, 90, innerHeight - 200)));
  });
  for (let i = 0; i < NUM_HANDS; i++) pointers.push(new Pointer(i, HAND_COLORS[i]));
}

// ---------- per-hand interaction ----------
function drivePointer(p, lm) {
  p.visible = true;
  const g = classify(lm, p.pinch);
  p.gesture = GESTURE_LABEL[g.name] || "—";

  // Cursor anchor: midpoint of the pinch while pinching, index tip otherwise.
  const tip = lm[LM.INDEX_TIP];
  const thumb = lm[LM.THUMB_TIP];
  const ax = g.isPinching ? (tip.x + thumb.x) / 2 : tip.x;
  const ay = g.isPinching ? (tip.y + thumb.y) / 2 : tip.y;

  // Mirror horizontally, then apply gain around the center.
  let nx = clamp(0.5 + (1 - ax - 0.5) * GAIN, 0, 1);
  let ny = clamp(0.5 + (ay - 0.5) * GAIN, 0, 1);
  p.setTarget(nx * innerWidth, ny * innerHeight);

  const was = p.pinch;
  p.pinch = g.isPinching;
  if (p.pinch && !was) onPinchStart(p);
  else if (p.pinch && was) onPinchHold(p);
  else if (!p.pinch && was) onPinchEnd(p);

  triggerGesture(p, g.name);
}

function deactivate(p) {
  if (p.pinch) onPinchEnd(p);
  p.visible = false;
  p.pinch = false;
  p.gesture = "—";
  p._lastName = "";
  p._hold = 0;
}

// Hit-test against the hand's true position (target), not the lagging cursor.
function onPinchStart(p) {
  if (zoom || otherHandPinching(p)) return; // two hands pinching → zoom, not grab/draw
  if (mode === "draw") {
    p.stroke = { x: p.tx, y: p.ty };
    return;
  }
  const w = toWorld(p.tx, p.ty);
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (!c.grabbedBy && c.contains(w.x, w.y)) {
      c.grabbedBy = p;
      p.grab = c;
      p.ox = w.x - c.x;
      p.oy = w.y - c.y;
      dom.scene.appendChild(c.el); // raise to front
      cards.splice(i, 1);
      cards.push(c);
      break;
    }
  }
}

function onPinchHold(p) {
  if (zoom) return; // two-hand zoom owns both hands
  if (mode === "draw") {
    paintSegment(p);
    return;
  }
  if (p.grab) {
    const w = toWorld(p.tx, p.ty);
    const nx = w.x - p.ox;
    const ny = w.y - p.oy;
    p.grab.vx = nx - p.grab.x; // remember velocity so a release "throws" the card
    p.grab.vy = ny - p.grab.y;
    p.grab.x = nx;
    p.grab.y = ny;
  }
}

function onPinchEnd(p) {
  if (mode === "draw") {
    p.stroke = null;
    return;
  }
  if (p.grab) {
    p.grab.grabbedBy = null;
    p.grab = null;
  }
}

function otherHandPinching(p) {
  return pointers.some((q) => q !== p && q.visible && q.pinch);
}

function releaseHeld() {
  for (const p of pointers) {
    if (p.grab) { p.grab.grabbedBy = null; p.grab = null; }
    p.stroke = null;
  }
}

// Two-hand pinch → zoom & pan the scene around the point between the hands.
// The world point initially under the hands stays under them, so spreading the
// hands zooms in toward it and moving both hands together pans the view.
function updateZoom() {
  const a = pointers[0];
  const b = pointers[1];
  const both = a && b && a.visible && b.visible && a.pinch && b.pinch;
  if (!both) {
    zoom = null; // released: keep the current view as-is
    return;
  }
  const mid = { x: (a.tx + b.tx) / 2, y: (a.ty + b.ty) / 2 };
  const dist = Math.hypot(a.tx - b.tx, a.ty - b.ty) || 1;
  if (!zoom) {
    releaseHeld(); // both hands now drive the zoom, not cards/drawing
    zoom = { startDist: dist, startScale: view.scale, anchor: toWorld(mid.x, mid.y) };
  }
  const scale = clamp(zoom.startScale * (dist / zoom.startDist), ZOOM_MIN, ZOOM_MAX);
  view.scale = scale;
  view.x = mid.x - zoom.anchor.x * scale;
  view.y = mid.y - zoom.anchor.y * scale;
  applyView();
}

// Debounced single-shot actions for whole-hand poses.
function triggerGesture(p, name) {
  if (name === p._lastName) p._hold++;
  else { p._lastName = name; p._hold = 0; }
  if (p._hold !== STABLE_FRAMES) return; // fire exactly once per hold
  if (name === "peace") toggleMode();
  else if (name === "fist") resetScene();
}

// ---------- modes & actions ----------
function toggleMode() {
  mode = mode === "drag" ? "draw" : "drag";
  releaseHeld(); // drop anything held so a card doesn't stick to the cursor
  dom.modeChip.textContent = mode === "drag" ? "模式：拖拽" : "模式：绘画";
  dom.modeChip.style.color = mode === "draw" ? "var(--lime)" : "";
}

function resetScene() {
  dctx.clearRect(0, 0, dom.draw.width, dom.draw.height);
  releaseHeld();
  cards.forEach((c) => c.goHome());
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  applyView();
}

// ---------- drawing ----------
function paintSegment(p) {
  if (!p.stroke) { p.stroke = { x: p.tx, y: p.ty }; return; }
  dctx.strokeStyle = p.color;
  dctx.lineWidth = 8;
  dctx.lineCap = "round";
  dctx.lineJoin = "round";
  dctx.shadowColor = p.color;
  dctx.shadowBlur = 16;
  dctx.beginPath();
  dctx.moveTo(p.stroke.x, p.stroke.y);
  dctx.lineTo(p.tx, p.ty);
  dctx.stroke();
  p.stroke = { x: p.tx, y: p.ty };
}

function drawFx() {
  fxctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of pointers) {
    if (p.trail.length < 2) continue;
    for (let i = 1; i < p.trail.length; i++) {
      const a = p.trail[i - 1];
      const b = p.trail[i];
      const t = i / p.trail.length;
      fxctx.strokeStyle = p.color;
      fxctx.globalAlpha = t * 0.5;
      fxctx.lineWidth = t * 10;
      fxctx.lineCap = "round";
      fxctx.beginPath();
      fxctx.moveTo(a.x, a.y);
      fxctx.lineTo(b.x, b.y);
      fxctx.stroke();
    }
  }
  fxctx.globalAlpha = 1;
}

// ---------- camera-preview skeleton overlay ----------
function drawOverlay(hands) {
  const w = dom.overlay.width;
  const h = dom.overlay.height;
  octx.clearRect(0, 0, w, h);
  hands.forEach((lm, idx) => {
    const color = HAND_COLORS[idx] || HAND_COLORS[0];
    octx.strokeStyle = color;
    octx.fillStyle = color;
    octx.lineWidth = 3;
    for (const [a, b] of HAND_CONNECTIONS) {
      octx.beginPath();
      octx.moveTo(lm[a].x * w, lm[a].y * h);
      octx.lineTo(lm[b].x * w, lm[b].y * h);
      octx.stroke();
    }
    for (const pt of lm) {
      octx.beginPath();
      octx.arc(pt.x * w, pt.y * h, 4, 0, Math.PI * 2);
      octx.fill();
    }
  });
}

// ---------- HUD ----------
function updateHud(handCount) {
  dom.fpsChip.textContent = `FPS：${Math.round(fps)}`;
  dom.handsChip.textContent = `手：${handCount}`;
  dom.zoomChip.textContent = `缩放：${Math.round(view.scale * 100)}%`;
  dom.zoomChip.style.color = zoom ? "var(--lime)" : "";
  const active = pointers.filter((p) => p.visible);
  dom.gestureChips.innerHTML = "";
  active.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "g-chip";
    chip.style.setProperty("--c", p.color);
    chip.textContent = p.gesture;
    dom.gestureChips.appendChild(chip);
  });
}

// ---------- main loop ----------
function loop() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(now - lastTime, 50);
  lastTime = now;
  fps = lerp(fps, 1000 / Math.max(dt, 1), 0.1);

  let handCount = 0;
  if (useCamera && landmarker && dom.video.readyState >= 2) {
    let results = lastResults;
    if (dom.video.currentTime !== lastVideoTime) {
      lastVideoTime = dom.video.currentTime;
      results = landmarker.detectForVideo(dom.video, now);
      lastResults = results;
    }
    const hands = (results && results.landmarks) || [];
    handCount = hands.length;
    const used = new Set();
    for (let i = 0; i < hands.length && i < pointers.length; i++) {
      drivePointer(pointers[i], hands[i]);
      used.add(i);
    }
    for (let i = 0; i < pointers.length; i++) {
      if (!used.has(i)) deactivate(pointers[i]);
    }
    drawOverlay(hands);
  } else if (useCamera) {
    handCount = 0;
  } else {
    handCount = pointers[0].visible ? 1 : 0;
  }

  updateZoom();
  for (const p of pointers) p.update();
  for (const c of cards) c.update(dt);
  drawFx();
  updateHud(handCount);
  requestAnimationFrame(loop);
}

// ---------- sizing ----------
function resizeCanvases() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const cnv of [dom.draw, dom.fx]) {
    cnv.width = innerWidth * dpr;
    cnv.height = innerHeight * dpr;
    cnv.style.width = innerWidth + "px";
    cnv.style.height = innerHeight + "px";
  }
  dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dom.overlay.width = dom.preview.clientWidth;
  dom.overlay.height = dom.preview.clientHeight;
}

// ---------- startup ----------
async function startCamera() {
  dom.error.classList.add("hidden");
  dom.loading.classList.remove("hidden");
  dom.btnCamera.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    dom.video.srcObject = stream;
    await dom.video.play();
    await initModel();
    useCamera = true;
    dom.preview.classList.remove("hidden");
    resizeCanvases(); // preview is visible now — size its overlay canvas properly
    begin();
  } catch (err) {
    console.error(err);
    dom.loading.classList.add("hidden");
    dom.error.classList.remove("hidden");
    dom.error.textContent =
      "无法启用手势识别：" + (err && err.message ? err.message : err) +
      "。已切换到鼠标模式。";
    dom.btnCamera.disabled = false;
    setTimeout(startMouse, 1400);
  }
}

async function initModel() {
  let vision = null;
  let HandLandmarkerCls = null;
  let lastErr = null;
  for (const base of VISION_CDNS) {
    try {
      const mod = await import(base);
      vision = await mod.FilesetResolver.forVisionTasks(base + "/wasm");
      HandLandmarkerCls = mod.HandLandmarker;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!vision || !HandLandmarkerCls) {
    throw lastErr || new Error("无法加载手势识别库（CDN 不可达）");
  }
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "VIDEO",
    numHands: NUM_HANDS,
  });
  try {
    landmarker = await HandLandmarkerCls.createFromOptions(vision, options("GPU"));
  } catch {
    landmarker = await HandLandmarkerCls.createFromOptions(vision, options("CPU"));
  }
}

function startMouse() {
  useCamera = false;
  dom.preview.classList.add("hidden");
  attachMouse();
  begin();
}

function begin() {
  if (running) return;
  dom.start.classList.add("hidden");
  running = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ---------- mouse / touch fallback ----------
function attachMouse() {
  const p = pointers[0];
  let touchZoom = null;

  const setTarget = (pt) => {
    p.visible = true;
    p.setTarget(pt.clientX, pt.clientY);
    p.x = pt.clientX; // no smoothing lag for direct input
    p.y = pt.clientY;
  };
  const twoFinger = (e) => {
    const a = e.touches[0];
    const b = e.touches[1];
    return {
      mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    };
  };

  // Mouse: hold the button to "pinch".
  addEventListener("mousemove", (e) => { setTarget(e); if (p.pinch) onPinchHold(p); });
  addEventListener("mousedown", (e) => { setTarget(e); if (!p.pinch) { p.pinch = true; onPinchStart(p); } });
  addEventListener("mouseup", () => { if (p.pinch) { p.pinch = false; onPinchEnd(p); } });

  // Touch: 1 finger = pinch/drag/draw, 2 fingers = pinch-to-zoom (like the
  // two-hand camera gesture). touch-action:none keeps the browser from zooming.
  addEventListener("touchstart", (e) => {
    p.gesture = "👆 触摸";
    if (e.touches.length >= 2) {
      if (p.pinch) { p.pinch = false; onPinchEnd(p); }
      const { mid, dist } = twoFinger(e);
      releaseHeld();
      touchZoom = { startDist: dist, startScale: view.scale, anchor: toWorld(mid.x, mid.y) };
    } else {
      setTarget(e.touches[0]);
      if (!p.pinch) { p.pinch = true; onPinchStart(p); }
    }
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (touchZoom && e.touches.length >= 2) {
      const { mid, dist } = twoFinger(e);
      const scale = clamp(touchZoom.startScale * (dist / touchZoom.startDist), ZOOM_MIN, ZOOM_MAX);
      view.scale = scale;
      view.x = mid.x - touchZoom.anchor.x * scale;
      view.y = mid.y - touchZoom.anchor.y * scale;
      applyView();
    } else if (!touchZoom) {
      setTarget(e.touches[0]);
      if (p.pinch) onPinchHold(p);
    }
  }, { passive: true });
  addEventListener("touchend", (e) => {
    if (e.touches.length < 2) touchZoom = null;
    if (e.touches.length === 0 && p.pinch) { p.pinch = false; onPinchEnd(p); }
  });

  addEventListener("keydown", (e) => {
    if (e.key === "d" || e.key === "D") toggleMode();
    if (e.key === "c" || e.key === "C") resetScene();
  });
  p.gesture = "🖱️ 鼠标";
}

// ---------- wire up ----------
function init() {
  buildScene();
  resizeCanvases();
  addEventListener("resize", resizeCanvases);
  dom.btnCamera.addEventListener("click", startCamera);
  dom.btnMouse.addEventListener("click", startMouse);
  dom.guideToggle.addEventListener("click", () =>
    dom.guide.classList.toggle("collapsed")
  );
  dom.btnMode.addEventListener("click", toggleMode);
  dom.btnReset.addEventListener("click", resetScene);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    dom.btnCamera.disabled = true;
    dom.btnCamera.textContent = "此环境不支持摄像头";
  }
}

init();
