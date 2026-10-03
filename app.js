import {
  avgWatts,
  createState,
  defaultSpecs,
  fitError,
  netOf,
  rig,
  sampleCycle,
  solvePlan,
  step,
} from "./sim.js?v=139";
import { draw, bindCam } from "./view.js?v=139";

// v3: the reference sail is 2.5×4 m on a 10 m track with a 0.5 s turn.
// Saved v2 specs would put the old 5×2 m machine back on screen.
const KEY = "windcart-v3";
const FIELDS = ["wind", "plateW", "plateH", "track", "mass", "outFrac", "vReturn", "turn", "fMax", "cd", "eta", "crr"];

let specs = loadSpecs();
let state = createState(specs);
let running = false;
let last = 0;
let spanTimer = 0;
// One settled cycle, cached, so the scrubber has something to slide along.
let cycle = null;
let cycleKey = "";
let scrub = null;
// Shown numbers ease, then hold. A ramp would still march the digits if they
// only lagged. The needle stays live.
let shownW = 0;
let shownV = 0;
let shownJ = 0;
let shownAt = 0;
let postedW = 0;
let postedV = 0;
let postedJ = 0;
let postedAt = 0;
// Full-scale watts for the dial. The slider's top is the cycle peak plus a
// thousand, and that is where the selection starts. The dial itself has no
// extra room: the selected number is the end of the sweep.
let dialScale = 2000;
let dialTopSeen = 0;

const $ = (id) => document.getElementById(id);

function loadSpecs() {
  const base = defaultSpecs();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-specs") || "null");
    if (saved && typeof saved === "object") return { ...base, ...saved, turnLead: 0.6 };
  } catch (e) {}
  return base;
}

function pin() {
  const r = document.documentElement;
  const n = navigator;
  const standalone =
    n.standalone === true ||
    (window.matchMedia &&
      (window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        window.matchMedia("(display-mode: minimal-ui)").matches));
  const vv = window.visualViewport;
  const iw = window.innerWidth || 0;
  const ih = window.innerHeight || 0;
  const sw = (window.screen && window.screen.width) || 0;
  const sh = (window.screen && window.screen.height) || 0;
  const screenMax = Math.max(sw, sh);
  const screenMin = Math.min(sw, sh);
  if (standalone) {
    r.classList.add("pwa-standalone");
    const fillH = ih >= iw ? Math.max(ih, screenMax) : Math.max(ih, screenMin);
    const extra = Math.min(iw, ih) >= 600 && screenMax < ih - 10 ? 20 : 0;
    r.style.setProperty("--pwa-fill-h", fillH + "px");
    r.style.setProperty("--pwa-extra-b", extra + "px");
    r.style.setProperty("--vv-top", "0px");
    r.style.setProperty("--vv-left", "0px");
    r.style.setProperty("--vv-w", iw + "px");
    r.style.setProperty("--vv-h", fillH + extra + "px");
  } else if (vv && vv.height > 40 && vv.width > 40) {
    r.classList.remove("pwa-standalone");
    r.style.setProperty("--vv-top", Math.max(0, Math.round(vv.offsetTop) || 0) + "px");
    r.style.setProperty("--vv-left", Math.max(0, Math.round(vv.offsetLeft) || 0) + "px");
    r.style.setProperty("--vv-w", Math.round(vv.width) + "px");
    r.style.setProperty("--vv-h", Math.round(vv.height) + "px");
  }
}

function readForm() {
  const next = { ...specs };
  for (const id of FIELDS) {
    next[id] = Number($(id).value);
  }
  return next;
}

function fillForm() {
  for (const id of FIELDS) $(id).value = String(specs[id]);
  paintForm();
}

function paintForm() {
  const s = readForm();
  $("o-wind").textContent = s.wind.toFixed(1) + " m/s";
  $("o-plateW").textContent = s.plateW.toFixed(1) + " m";
  $("o-plateH").textContent = s.plateH.toFixed(1) + " m";
  $("o-area").textContent = (s.plateW * s.plateH).toFixed(1) + " m²";
  $("o-track").textContent = s.track.toFixed(0) + " m";
  const r = rig(s);
  $("o-mass").textContent = s.mass.toFixed(0) + " kg · " + r.total.toFixed(0) + " all up";
  const frac = s.outFrac;
  $("o-outFrac").textContent =
    Math.abs(frac - 1 / 3) < 0.012 ? "1/3 wind" : (frac * s.wind).toFixed(1) + " m/s";
  $("o-vReturn").textContent = s.vReturn.toFixed(1) + " m/s";
  $("o-turn").textContent = s.turn.toFixed(1) + " s";
  $("o-fMax").textContent = s.fMax.toFixed(0) + " N";
  $("o-cd").textContent = r.cd.toFixed(2);
  $("o-eta").textContent = Math.round(s.eta * 100) + "%";
  $("o-crr").textContent = s.crr.toFixed(3);
  $("warn").textContent = fitError(s);
}

function ensureCycle() {
  const key = JSON.stringify(specs);
  if (cycle !== null && cycleKey === key) return cycle;
  cycleKey = key;
  cycle = sampleCycle(specs);
  return cycle;
}

function dropCycle() {
  cycle = null;
  cycleKey = "";
}

/** Put the machine where it would be at this fraction of one cycle. */
function applyScrub(frac) {
  scrub = Math.max(0, Math.min(1, frac));
  const c = ensureCycle();
  if (!c) {
    paint();
    return;
  }
  const i = Math.round(scrub * (c.frames.length - 1));
  Object.assign(state, c.frames[i]);
  paint();
}

function clearScrub() {
  scrub = null;
  $("track-map").classList.remove("is-scrubbing");
}

function dialTop() {
  const peak = cycle && cycle.span ? Math.max(0, cycle.span - 1000) : 0;
  return Math.max(500, Math.round((peak + 1000) / 50) * 50);
}

function syncDialScale() {
  const top = dialTop();
  const input = $("dial-scale");
  if (!input) return;
  input.min = "200";
  input.step = "50";
  input.max = String(top);
  if (top !== dialTopSeen) {
    dialTopSeen = top;
    dialScale = top;
  }
  dialScale = Math.min(top, Math.max(200, dialScale));
  input.value = String(dialScale);
  $("o-dial").textContent = Math.round(dialScale).toLocaleString("en-US") + " W";
}

function refreshSpan() {
  ensureCycle();
  syncDialScale();
}

function scheduleSpan() {
  clearTimeout(spanTimer);
  spanTimer = setTimeout(refreshSpan, 60);
}

function fmtW(w) {
  const n = Math.round(w);
  const sign = n > 0 ? "+" : "";
  return sign + n.toLocaleString("en-US") + " W";
}

function fmtKJ(j) {
  const sign = j > 0 ? "+" : "";
  return sign + (j / 1000).toFixed(2) + " kJ";
}

function ease(cur, target, dt, tau) {
  if (!(dt > 0)) return target;
  const a = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * a;
}

function paint() {
  const now = performance.now() / 1000;
  const dt = shownAt ? Math.min(0.1, now - shownAt) : 0.016;
  shownAt = now;
  shownW = ease(shownW, state.inst, dt, 0.3);
  shownV = ease(shownV, state.vx, dt, 0.3);
  const net = netOf(state);
  if (scrub == null) shownJ = ease(shownJ, net, dt, 0.3);
  const dur = cycle ? cycle.seconds : state.lastCycleS;
  const post = scrub != null || now - postedAt >= 0.35;
  if (post) {
    postedAt = now;
    postedW = shownW;
    postedV = shownV;
    postedJ = shownJ;
    $("speed").textContent = postedV.toFixed(1) + " m/s";
    $("watts").textContent = fmtW(postedW);
    $("watts").style.color = postedW >= 0 ? "var(--green)" : "var(--amber)";
    if (scrub != null) {
      $("net").textContent = (scrub * dur).toFixed(2) + " s";
      $("substat").textContent = "";
    } else {
      $("net").textContent = "net " + fmtKJ(postedJ);
      const avg = avgWatts(state);
      $("substat").textContent = avg == null ? "" : Math.round(avg) + " W avg";
    }
  }
  let frac;
  if (scrub != null) frac = scrub;
  else if (dur > 0) frac = Math.min(1, state.cycleT / dur);
  else frac = 0;
  const pctAlong = Math.max(0, Math.min(100, frac * 100));
  $("map-dot").style.left = pctAlong + "%";
  $("track-map").setAttribute("aria-valuenow", Math.round(pctAlong));
  paintGauge();
  draw($("view"), state);
}

/**
 * One round dial, as tall as its box. The top half is power: green is watts
 * being made, yellow is watts being used. The bottom half is speed. Straight
 * up and straight down are zero. Right is downwind, left is the return.
 * Full scale is the hard part of one settled cycle.
 */
function paintGauge() {
  const canvas = $("gauge");
  if (!canvas) return;
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  const pw = Math.floor(w * dpr);
  const ph = Math.floor(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const frames = cycle && cycle.frames;
  let speedScale = Math.max(1, Math.abs(state.specs.wind), Math.abs(state.specs.vReturn || 0));
  if (frames && frames.length > 1) {
    for (const f of frames) speedScale = Math.max(speedScale, Math.abs(f.vx));
  }
  const r = Math.max(8, h / 2 - 3);
  drawRoundDial(ctx, w / 2, h / 2, r, state.inst / Math.max(1, dialScale), state.vx / speedScale);
}

/** Top half. -1 is left, 0 is up, 1 is right. */
function powerAngle(t) {
  const v = Math.max(-1, Math.min(1, t));
  return Math.PI + ((v + 1) / 2) * Math.PI;
}

/** Bottom half. -1 is left, 0 is down, 1 is right. */
function speedAngle(t) {
  const v = Math.max(-1, Math.min(1, t));
  return Math.PI / 2 - v * (Math.PI / 2);
}

function drawRoundDial(ctx, cx, cy, r, power, speed) {
  const p = Math.max(-1, Math.min(1, power));
  const s = Math.max(-1, Math.min(1, speed));
  const gen = Math.max(0, p);
  const use = Math.max(0, -p);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.lineWidth = 4;
  ctx.stroke();
  if (gen > 0.004) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 1.5 * Math.PI, powerAngle(gen), false);
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  if (use > 0.004) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 1.5 * Math.PI, powerAngle(-use), true);
    ctx.strokeStyle = "#ffe14a";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI / 2, speedAngle(s), s > 0);
  ctx.strokeStyle = "#3d9cf5";
  ctx.lineWidth = 4;
  ctx.stroke();

  const hand = (ang, len, color, width) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  hand(speedAngle(s), r - 7, "#3d9cf5", 2);
  hand(powerAngle(-use), r - 7, "#ffe14a", 1.75);
  hand(powerAngle(gen), r - 7, "#34d399", 1.75);
  ctx.beginPath();
  ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = "#e8edf4";
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 10px IBM Plex Mono, ui-monospace, monospace";
  ctx.fillStyle = "#34d399";
  ctx.fillText("W", cx - r * 0.34, cy - r * 0.28);
  ctx.fillStyle = "#3d9cf5";
  ctx.font = "600 9px IBM Plex Mono, ui-monospace, monospace";
  ctx.fillText("m/s", cx - r * 0.2, cy + r * 0.36);
}

function frame(t) {
  if (running) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (dt > 0) step(state, dt);
  } else {
    last = t;
  }
  paint();
  requestAnimationFrame(frame);
}

function setRunning(on) {
  if (on) {
    const err = fitError(specs);
    if (err) {
      $("warn").textContent = err;
      return;
    }
    specs = readForm();
    localStorage.setItem(KEY + "-specs", JSON.stringify(specs));
    state = createState(specs);
    clearScrub();
    running = true;
    last = 0;
    $("run").textContent = "Stop";
    $("run").className = "stop";
  } else {
    running = false;
    $("run").textContent = "Run";
    $("run").className = "go";
  }
}

function closeSheet() {
  $("sheet").hidden = true;
}

const map = $("track-map");

function mapFrac(e) {
  const r = map.getBoundingClientRect();
  return (e.clientX - r.left) / Math.max(1, r.width);
}

// Track the drag with our own flag. Gating moves on hasPointerCapture meant a
// capture that failed to take left the handle dead for the rest of the drag.
let dragId = null;

map.addEventListener(
  "pointerdown",
  (e) => {
    dragId = e.pointerId;
    try {
      map.setPointerCapture(e.pointerId);
    } catch (err) {
      /* capture is a nicety, the drag works without it */
    }
    map.classList.add("is-scrubbing");
    if (running) setRunning(false);
    applyScrub(mapFrac(e));
    e.preventDefault();
  },
  { passive: false }
);
map.addEventListener(
  "pointermove",
  (e) => {
    if (dragId !== e.pointerId) return;
    applyScrub(mapFrac(e));
    e.preventDefault();
  },
  { passive: false }
);
for (const kind of ["pointerup", "pointercancel", "lostpointercapture"]) {
  map.addEventListener(kind, (e) => {
    if (dragId !== e.pointerId) return;
    dragId = null;
    try {
      map.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already gone */
    }
    map.classList.remove("is-scrubbing");
  });
}
map.addEventListener("keydown", (e) => {
  const stepBy = e.key === "ArrowLeft" ? -0.02 : e.key === "ArrowRight" ? 0.02 : 0;
  if (!stepBy) return;
  if (running) setRunning(false);
  applyScrub((scrub ?? 0) + stepBy);
  e.preventDefault();
});

$("run").addEventListener("click", () => setRunning(!running));
$("specs-btn").addEventListener("click", () => {
  $("sheet").hidden = !$("sheet").hidden;
});
$("close-specs").addEventListener("click", closeSheet);
document.addEventListener(
  "pointerdown",
  (e) => {
    const sheet = $("sheet");
    if (sheet.hidden) return;
    if (sheet.contains(e.target)) return;
    if ($("specs-btn").contains(e.target)) return;
    closeSheet();
  },
  true
);
$("defaults").addEventListener("click", () => {
  if (running) return;
  specs = defaultSpecs();
  dropCycle();
  clearScrub();
  state = createState(specs);
  fillForm();
  refreshSpan();
  paint();
});
$("solve").addEventListener("click", async () => {
  if (running) return;
  const btn = $("solve");
  btn.textContent = "Solving";
  btn.disabled = true;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const base = readForm();
    const plan = solvePlan(base);
    specs = { ...base, outFrac: plan.outFrac, turn: plan.turn, turnLead: 0.6 };
    dropCycle();
    clearScrub();
    state = createState(specs);
    fillForm();
    refreshSpan();
    paint();
    $("warn").textContent = "Best found: " + Math.round(plan.avgW) + " W average";
  } finally {
    btn.textContent = "Solve";
    btn.disabled = false;
  }
});
$("dial-scale").addEventListener("input", () => {
  dialScale = Number($("dial-scale").value);
  $("o-dial").textContent = Math.round(dialScale).toLocaleString("en-US") + " W";
});
for (const id of FIELDS) {
  $(id).addEventListener("input", () => {
    paintForm();
    specs = readForm();
    dropCycle();
    scheduleSpan();
    const next = createState(specs);
    if (running) state.specs = next.specs;
    else state = next;
    if (!running && scrub != null) applyScrub(scrub);
    else paint();
  });
}

fillForm();
refreshSpan();
pin();
bindCam($("view"), () => {
  $("cam-hint")?.classList.add("is-gone");
  if (!running) paint();
});
paint();
window.addEventListener("resize", pin);
window.visualViewport?.addEventListener("resize", pin);
window.visualViewport?.addEventListener("scroll", pin);
requestAnimationFrame(frame);
