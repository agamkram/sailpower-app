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
} from "./sim.js?v=128";
import { draw, bindCam } from "./view.js?v=128";

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

function fmtKJ(j) {
  const sign = j > 0 ? "+" : "";
  return sign + (j / 1000).toFixed(2) + " kJ";
}

function paint() {
  $("speed").textContent = state.vx.toFixed(1) + " m/s";
  $("watts").textContent = fmtW(state.inst);
  $("watts").style.color = state.inst >= 0 ? "var(--green)" : "var(--amber)";
  const net = netOf(state);
  const dur = cycle ? cycle.seconds : state.lastCycleS;
  if (scrub != null) {
    $("net").textContent = (scrub * dur).toFixed(2) + " s";
    $("substat").textContent = "";
  } else {
    $("net").textContent = "net " + fmtKJ(net);
    const avg = avgWatts(state);
    $("substat").textContent = avg == null ? "" : Math.round(avg) + " W avg";
  }
  let frac;
  if (scrub != null) frac = scrub;
  else if (dur > 0) frac = Math.min(1, state.cycleT / dur);
  else frac = 0;
  const pctAlong = Math.max(0, Math.min(100, frac * 100));
  $("map-dot").style.left = pctAlong + "%";
  $("track-map").setAttribute("aria-valuenow", Math.round(pctAlong));
  paintGauge(frac);
  draw($("view"), state);
}

/** One settled cycle. Green is power made, amber is power spent. The line is now. */
function paintGauge(frac) {
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
  const mid = h / 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  const frames = cycle && cycle.frames;
  if (frames && frames.length > 1) {
    const scale = Math.max(1, (cycle.span || 0) - 1000);
    const yOf = (inst) => mid - Math.max(-1, Math.min(1, inst / scale)) * (mid - 1);
    const area = (above) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, above ? 0 : mid, w, mid);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i < frames.length; i++) {
        ctx.lineTo((i / (frames.length - 1)) * w, yOf(frames[i].inst));
      }
      ctx.lineTo(w, mid);
      ctx.closePath();
      ctx.fillStyle = above ? "rgba(52, 211, 153, 0.9)" : "rgba(251, 191, 36, 0.92)";
      ctx.fill();
      ctx.restore();
    };
    area(true);
    area(false);
    const x = Math.max(0, Math.min(1, frac)) * w;
    ctx.strokeStyle = "rgba(232, 237, 244, 0.95)";
    ctx.beginPath();
    ctx.moveTo(x, 1);
    ctx.lineTo(x, h - 1);
    ctx.stroke();
  }
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
