import {
  createState,
  defaultSpecs,
  fitError,
  holdForce,
  ranges,
  rig,
  sampleCycle,
  solvePlan,
  step,
} from "./sim.js?v=188";
import { draw, bindCam } from "./view.js?v=188";

// v4: the tool opens on the 2×5 m sail already set to its best plan.
// Older saves would put an unsolved controller back on screen.
const KEY = "sailpower-v1";
const FIELDS = ["wind", "plateW", "plateH", "track", "mass", "outFrac", "vReturn", "turn", "fMax", "cd", "eta", "crr"];

let specs = loadSpecs();
let lastBest = loadBest(specs);
let state = createState(specs);
let running = false;
let last = 0;
let spanTimer = 0;
// One settled cycle, cached, so the scrubber has something to slide along.
let cycle = null;
let cycleKey = "";
let scrub = null;
// Last number written. It stays until the sim has moved past it, so chatter
// does not change the digits and a real change shows up immediately.
let postedW = null;
let postedV = null;
let postedScore = "";

const $ = (id) => document.getElementById(id);

function loadSpecs() {
  const base = defaultSpecs();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-specs") || "null");
    if (saved && typeof saved === "object") return { ...base, ...saved };
  } catch (e) {}
  return base;
}

function loadBest(s) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-best") || "null");
    if (saved && typeof saved === "object") return { ...s, ...saved };
  } catch (e) {}
  return { ...s };
}

function markBest(s) {
  lastBest = { ...s };
  try {
    localStorage.setItem(KEY + "-best", JSON.stringify(lastBest));
  } catch (e) {}
}

function fieldOff(id, value) {
  if (lastBest == null || lastBest[id] == null) return true;
  const step = Number($(id).step) || 0.01;
  return Math.abs(Number(value) - Number(lastBest[id])) > step * 0.51;
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

/**
 * Move the drive sliders' ends to suit the sail. A range input clamps its own
 * value when min or max moves, so the caller re-reads the form afterwards.
 */
function applyRanges(s) {
  const lim = ranges(s);
  for (const id of Object.keys(lim)) {
    const el = $(id);
    el.min = String(lim[id].min);
    el.max = String(lim[id].max);
    el.step = String(lim[id].step);
  }
}

function fillForm() {
  applyRanges(specs);
  for (const id of FIELDS) $(id).value = String(specs[id]);
  paintForm();
}

function paintForm() {
  applyRanges(readForm());
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
  // Against the sail it has to hold, so a rail that is only just big enough
  // reads as one rather than looking like any other number of newtons.
  $("o-fMax").textContent =
    s.fMax.toFixed(0) + " N · " + (s.fMax / Math.max(1, holdForce(s))).toFixed(1) + "× hold";
  $("o-cd").textContent = r.cd.toFixed(2);
  $("o-eta").textContent = Math.round(s.eta * 100) + "%";
  $("o-crr").textContent = s.crr.toFixed(3);
  $("warn").textContent = fitError(s);
  let off = false;
  for (const id of FIELDS) {
    const away = fieldOff(id, s[id]);
    $(id).closest("label")?.classList.toggle("is-off", away);
    if (away) off = true;
  }
  $("solve")?.classList.toggle("is-needed", off);
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

function refreshSpan() {
  ensureCycle();
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

function paint() {
  const dur = cycle ? cycle.seconds : state.lastCycleS;
  if (scrub != null || postedW == null || Math.abs(state.inst - postedW) >= 40) {
    postedW = state.inst;
    $("watts").textContent = fmtW(postedW);
    $("watts").style.color = postedW >= 0 ? "var(--green)" : "var(--amber)";
  }
  if (scrub != null || postedV == null || Math.abs(state.vx - postedV) >= 0.2) {
    postedV = state.vx;
    const way = state.vx > 0.2 ? " out" : state.vx < -0.2 ? " home" : "";
    $("speed").textContent = postedV.toFixed(1) + " m/s" + way;
  }
  paintScore();
  let frac;
  if (scrub != null) frac = scrub;
  else if (dur > 0) frac = Math.min(1, state.cycleT / dur);
  else frac = 0;
  const pctAlong = Math.max(0, Math.min(100, frac * 100));
  $("map-dot").style.left = pctAlong + "%";
  $("track-map").setAttribute("aria-valuenow", Math.round(pctAlong));
  draw($("view"), state);
}

/** The last finished trip. Until one has actually run, every line is zero. */
function tripScore() {
  if (state.cycles >= 1 && state.lastCycleS > 0) {
    const t = state.lastCycleS;
    return {
      made: state.lastGen / t,
      motor: state.lastMot / t,
      slew: state.lastSlew / t,
      loss: state.lastLoss / t,
      stop: state.lastStop / t,
      net: state.lastCycleNet / t,
    };
  }
  return { made: 0, motor: 0, slew: 0, loss: 0, stop: 0, net: 0 };
}

function paintScore() {
  const t = tripScore();
  const parts = t
    ? [
        ["net", t.net],
        ["t-made", t.made],
        ["t-motor", -t.motor],
        ["t-slew", -t.slew],
        ["t-loss", -t.loss],
        ["t-stop", -t.stop],
      ]
    : [
        ["net", null],
        ["t-made", null],
        ["t-motor", null],
        ["t-slew", null],
        ["t-loss", null],
        ["t-stop", null],
      ];
  const key = parts.map((p) => (p[1] == null ? "—" : Math.round(p[1]))).join("|");
  if (key === postedScore) return;
  postedScore = key;
  for (const [id, watts] of parts) {
    const el = $(id);
    el.textContent = watts == null ? "—" : fmtW(watts);
    if (id === "net") el.style.color = watts == null || watts >= 0 ? "var(--green)" : "var(--amber)";
  }
}

let raf = 0;

function frame(t) {
  if (running) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (dt > 0) step(state, dt);
  } else {
    last = t;
  }
  paint();
  raf = document.hidden ? 0 : requestAnimationFrame(frame);
}

function startLoop() {
  if (raf || document.hidden) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

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
  markBest(specs);
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
  btn.textContent = "Finding";
  btn.disabled = true;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const base = readForm();
    const plan = solvePlan(base);
    specs = {
      ...base,
      outFrac: plan.outFrac,
      vReturn: plan.vReturn,
      turn: plan.turn,
      turnLead: plan.turnLead,
    };
    markBest(specs);
    dropCycle();
    clearScrub();
    state = createState(specs);
    fillForm();
    refreshSpan();
    paint();
    $("warn").textContent = Number.isFinite(plan.avgW)
      ? "Best · " + Math.round(plan.avgW) + " W"
      : "No plan for these specs.";
  } finally {
    btn.textContent = "Best";
    btn.disabled = false;
  }
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
{
  const tag = $("build-tag");
  if (tag) {
    const src = document.querySelector('script[type="module"][src*="app.js"]')?.getAttribute("src") || "";
    const m = src.match(/\?v=(\d+)/);
    tag.textContent = m ? "v" + m[1] : "";
  }
}
bindCam($("view"), () => {
  $("cam-hint")?.classList.add("is-gone");
  if (!running) paint();
});
paint();
window.addEventListener("resize", pin);
window.visualViewport?.addEventListener("resize", pin);
window.visualViewport?.addEventListener("scroll", pin);
startLoop();
