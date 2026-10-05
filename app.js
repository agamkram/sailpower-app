import {
  createState,
  defaultSpecs,
  fitError,
  ranges,
  sizeMachine,
  sampleCycle,
  solvePlan,
  step,
} from "./sim.js?v=226";
import { draw, bindCam } from "./view.js?v=226";

// v4: the tool opens on the 2×5 m sail already set to its best plan.
// Older saves would put an unsolved controller back on screen.
const KEY = "sailpower-v1";
const FIELDS = ["wind", "plateW", "plateH", "track", "outFrac", "vReturn", "turn", "turnLead", "harvest"];

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
// Peak marks. The scale stays the sampled trip, so a longer bar is always
// more. A mark stays at the hardest reading until the trip ends.
const peaks = { make: 0, use: 0, motor: 0, out: 0, home: 0 };
let peakCycle = 0;
let postedM = null;
let motorMark = null;
let motorW = 0;

const $ = (id) => document.getElementById(id);

function loadSpecs() {
  const base = defaultSpecs();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-specs") || "null");
    if (saved && typeof saved === "object") return sizeMachine({ ...base, ...saved });
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

function rememberSpecs(s) {
  try {
    localStorage.setItem(KEY + "-specs", JSON.stringify(s));
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
  return sizeMachine(next);
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
  $("view-wind").textContent = s.wind.toFixed(1) + " m/s";
  $("o-plateW").textContent = s.plateW.toFixed(1) + " m";
  $("o-plateH").textContent = s.plateH.toFixed(1) + " m";
  const area = (s.plateW * s.plateH).toFixed(1) + " m²";
  $("o-area").textContent = area;
  $("view-area").textContent = area;
  $("o-track").textContent = s.track.toFixed(0) + " m";
  const frac = s.outFrac;
  $("o-outFrac").textContent =
    Math.abs(frac - 1 / 3) < 0.012 ? "1/3 wind" : (frac * s.wind).toFixed(1) + " m/s";
  $("o-vReturn").textContent = returnText(s);
  $("o-turn").textContent = s.turn.toFixed(1) + " s";
  $("o-turnLead").textContent = leadText(s);
  $("o-harvest").textContent = Math.round(s.harvest) + "% of the wind";
  // A dead calm is a legal setting, not a broken one. Say so, rather than
  // leaving every column on zero with nothing to explain it.
  $("warn").textContent = fitError(s) || (s.wind > 0 ? "" : "No wind — nothing to harvest.");
  let off = false;
  for (const id of FIELDS) {
    const away = fieldOff(id, s[id]);
    $(id).closest("label")?.classList.toggle("is-off", away);
    if (away) off = true;
  }
  $("solve")?.classList.toggle("is-needed", off);
}

/**
 * Where the 90° slew sits against arrival. 0 waits until the cart has stopped.
 * The setting is what the drive is asked for; `leadMade` is how far round the
 * sail actually is when the cart is held, at whichever cap manages less.
 * Coming home the wind sets that ceiling near three-quarters however early
 * the turn starts, so the ask on its own would over-promise.
 */
function leadText(s) {
  const n = Number(s.turnLead);
  const named = [
    [0, "Once stopped"],
    [0.3, "Mostly stopped"],
    [0.6, "While slowing"],
    [1, "Done on arrival"],
  ];
  let out = Math.round(n * 100) + "% before the stop";
  for (const [at, label] of named) {
    if (Math.abs(n - at) <= 0.026) out = label;
  }
  if (!cycle || !samePlan(s, specs)) return out;
  const made = cycle.leadMade;
  if (made == null) return out;
  return out + " · " + Math.round(made * 100) + "% turned";
}

/** Commanded return, and the speed the cart actually reaches on the way home. */
function samePlan(a, b) {
  if (!a || !b) return false;
  for (const id of FIELDS) {
    if (Math.abs(Number(a[id]) - Number(b[id])) > 1e-6) return false;
  }
  return true;
}

function returnText(s) {
  const cmd = Number(s.vReturn).toFixed(1) + " m/s";
  if (!cycle || !samePlan(s, specs)) return cmd;
  const peak = cycle.homePeak;
  if (!(peak > 0.05)) return cmd;
  return cmd + ", peaks " + peak.toFixed(1);
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
  const s = readForm();
  $("o-vReturn").textContent = returnText(s);
  $("o-turnLead").textContent = leadText(s);
}

function scheduleSpan() {
  clearTimeout(spanTimer);
  spanTimer = setTimeout(refreshSpan, 60);
}

function fmtW(w) {
  // Rounding a small negative gives -0, which prints as "-0 W" and reads like
  // a fault. Nothing is nothing.
  const n = Math.round(w) || 0;
  const sign = n > 0 ? "+" : "";
  return sign + n.toLocaleString("en-US") + " W";
}

function paint() {
  const dur = cycle ? cycle.seconds : state.lastCycleS;
  if (scrub != null || postedW == null || Math.abs(Math.max(0, state.inst) - postedW) >= 40) {
    postedW = Math.max(0, state.inst);
    $("watts").textContent = fmtW(postedW);
    $("watts").style.color = "var(--green)";
  }
  if (scrub != null || postedV == null || Math.abs(state.vx - postedV) >= 0.2) {
    postedV = state.vx;
    $("speed").textContent = Math.abs(postedV).toFixed(1) + " m/s";
  }
  paintScore();
  paintMeters();
  let frac;
  if (scrub != null) frac = scrub;
  else if (dur > 0) frac = Math.min(1, state.cycleT / dur);
  else frac = 0;
  const pctAlong = Math.max(0, Math.min(100, frac * 100));
  $("map-dot").style.left = pctAlong + "%";
  $("track-map").setAttribute("aria-valuenow", Math.round(pctAlong));
  draw($("view"), state);
}

function meterScale() {
  if (scaleKey === cycleKey && cachedScale) return cachedScale;
  scaleKey = cycleKey;
  peaks.make = peaks.use = peaks.motor = peaks.out = peaks.home = 0;
  motorMark = null;
  motorW = 0;
  let make = 1;
  let use = 1;
  let out = Math.max(0.5, Math.abs(specs.wind * specs.outFrac));
  let home = Math.max(0.5, Math.abs(specs.vReturn));
  let motor = 1;
  const frames = cycle && cycle.frames;
  if (frames) {
    for (const f of frames) {
      if (f.inst > make) make = f.inst;
      if (f.inst < 0 && -f.inst > use) use = -f.inst;
      if (f.vx > out) out = f.vx;
      if (f.vx < 0 && -f.vx > home) home = -f.vx;
      if (f.rate && f.rate.motor > motor) motor = f.rate.motor;
    }
  }
  cachedScale = { make, use, motor, out, home };
  return cachedScale;
}

let scaleKey = "";
let cachedScale = null;

function hold(name, value) {
  if (value > peaks[name]) peaks[name] = value;
}

function motorNow() {
  if (scrub != null && cycle && cycle.frames.length) {
    const i = Math.round(scrub * (cycle.frames.length - 1));
    const rate = cycle.frames[i].rate;
    return Math.max(0, rate ? rate.motor : 0);
  }
  if (!motorMark || state.time < motorMark.t) {
    motorMark = { t: state.time, mot: state.mot };
    motorW = 0;
    return 0;
  }
  const dt = state.time - motorMark.t;
  if (dt < 1e-4) return motorW;
  const raw = Math.max(0, (state.mot - motorMark.mot) / dt);
  motorMark = { t: state.time, mot: state.mot };
  const a = 1 - Math.exp(-dt / 0.12);
  motorW += (raw - motorW) * a;
  return motorW;
}

function paintMeters() {
  if (state.cycles !== peakCycle) {
    peakCycle = state.cycles;
    peaks.make = peaks.use = peaks.motor = peaks.out = peaks.home = 0;
  }
  const scale = meterScale();
  const make = Math.max(0, state.inst);
  const motor = motorNow();
  const out = Math.max(0, state.vx);
  const home = Math.max(0, -state.vx);
  hold("make", make);
  hold("motor", motor);
  hold("out", out);
  hold("home", home);
  if (scrub != null || postedM == null || Math.abs(motor - postedM) >= 20) {
    postedM = motor;
    $("motor").textContent = fmtW(-motor);
    $("motor").style.color = motor > 1 ? "var(--amber)" : "var(--text)";
  }
  const slip = (id, frac) => {
    $(id).style.transform = "scaleX(" + Math.max(0, Math.min(1, frac)) + ")";
  };
  const mark = (id, frac, side) => {
    const f = Math.max(0, Math.min(1, frac));
    $(id).style.left = (side === 0 ? f * 100 : side > 0 ? 50 + f * 50 : 50 - f * 50) + "%";
  };
  slip("bar-make", make / scale.make);
  slip("bar-motor", motor / scale.motor);
  slip("bar-out", out / scale.out);
  slip("bar-home", home / scale.home);
  mark("peak-make", peaks.make / scale.make, 0);
  mark("peak-motor", peaks.motor / scale.motor, 0);
  mark("peak-out", peaks.out / scale.out, 1);
  mark("peak-home", peaks.home / scale.home, -1);
}

/** Trip, Last and Save are the same ledger: energy over the cycle clock.
 * Made falls on the way home because the clock keeps running after the
 * coils stop generating. Last locks from the cycle that just closed.
 */
let madeCycle = -1;
let lastTrip = zeroTrip();
let saveTrip = loadSave();

function zeroTrip() {
  return { made: 0, motor: 0, slew: 0, loss: 0, stop: 0, net: 0 };
}

function loadSave() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-save") || "null");
    if (saved && typeof saved.net === "number") return saved;
  } catch (e) {}
  return zeroTrip();
}

function wattsOf(made, motor, slew, loss, stop, t) {
  if (!(t > 0)) return zeroTrip();
  return {
    made: made / t,
    motor: motor / t,
    slew: slew / t,
    loss: loss / t,
    stop: stop / t,
    net: (made - motor - slew - loss - stop) / t,
  };
}

function tripScore() {
  if (scrub != null && cycle && cycle.frames.length) {
    const i = Math.round(scrub * (cycle.frames.length - 1));
    const led = cycle.frames[i].ledger;
    if (led) {
      liveTrip = { ...led };
      return liveTrip;
    }
  }
  if (state.cycles !== madeCycle) {
    if (madeCycle >= 0 && state.lastCycleS > 0) {
      lastTrip = wattsOf(
        state.lastGen,
        state.lastMot,
        state.lastSlew,
        state.lastLoss,
        state.lastStop,
        state.lastCycleS
      );
    }
    madeCycle = state.cycles;
  }
  liveTrip =
    state.cycleT > 0.05
      ? wattsOf(state.cycleGen, state.cycleMot, state.cycleSlew, state.cycleLoss, state.cycleStop, state.cycleT)
      : wattsOf(state.lastGen, state.lastMot, state.lastSlew, state.lastLoss, state.lastStop, state.lastCycleS);
  return liveTrip;
}

let liveTrip = zeroTrip();

function paintScore() {
  const t = tripScore();
  const cells = [];
  const add = (id, trip, row) => {
    const raw = trip[row === "stop" ? "stop" : row];
    const watts = row === "made" || row === "net" ? raw : -raw;
    cells.push([id, watts, row === "net"]);
  };
  add("net", t, "net");
  add("l-net", lastTrip, "net");
  add("s-net", saveTrip, "net");
  for (const row of ["made", "motor", "slew", "loss", "stop"]) {
    const id = row === "stop" ? "stop" : row;
    add("t-" + id, t, row);
    add("l-" + id, lastTrip, row);
    add("s-" + id, saveTrip, row);
  }
  const key = cells.map((c) => Math.round(c[1])).join("|");
  if (key === postedScore) return;
  postedScore = key;
  for (const [id, watts, isNet] of cells) {
    const el = $(id);
    if (!el) continue;
    el.textContent = fmtW(watts);
    if (isNet) el.style.color = watts >= 0 ? "var(--green)" : "var(--amber)";
  }
}

let raf = 0;
let idleTimer = 0;

function frame(t) {
  if (running) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (dt > 0) step(state, dt);
  } else {
    last = t;
  }
  paint();
  if (document.hidden) {
    raf = 0;
    return;
  }
  // The wind keeps moving while the cart is stopped, but it does not need
  // a full phone refresh. Half rate is the difference between warm and hot.
  if (running) raf = requestAnimationFrame(frame);
  else {
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      raf = requestAnimationFrame(frame);
    }, 32);
  }
}

function startLoop() {
  if (raf || idleTimer || document.hidden) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

function stopLoop() {
  cancelAnimationFrame(raf);
  clearTimeout(idleTimer);
  raf = 0;
  idleTimer = 0;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop();
  else startLoop();
});
window.addEventListener("pagehide", stopLoop);

function setRunning(on) {
  if (on) {
    const err = fitError(specs);
    if (err) {
      $("warn").textContent = err;
      return;
    }
    specs = readForm();
    rememberSpecs(specs);
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

function paintSaveButton() {
  $("save-btn").textContent = saveTrip.made || saveTrip.net ? "Clear" : "Save";
}

$("run").addEventListener("click", () => setRunning(!running));
$("save-btn").addEventListener("click", () => {
  if (saveTrip.made || saveTrip.net) {
    saveTrip = zeroTrip();
    try {
      localStorage.removeItem(KEY + "-save");
    } catch (e) {}
  } else {
    const shot = lastTrip.made || lastTrip.net ? lastTrip : liveTrip;
    saveTrip = { ...shot, specs: { ...state.specs } };
    try {
      localStorage.setItem(KEY + "-save", JSON.stringify(saveTrip));
    } catch (e) {}
  }
  paintSaveButton();
  postedScore = "";
  paintScore();
});
paintSaveButton();
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
  if (running) setRunning(false);
  specs = defaultSpecs();
  markBest(specs);
  rememberSpecs(specs);
  dropCycle();
  clearScrub();
  state = createState(specs);
  fillForm();
  refreshSpan();
  paint();
});
$("solve").addEventListener("click", async () => {
  if (running) setRunning(false);
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
    rememberSpecs(specs);
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
bindCam($("view"), () => {
  $("cam-hint")?.classList.add("is-gone");
  if (!running) paint();
});
paint();
window.addEventListener("resize", pin);
window.visualViewport?.addEventListener("resize", pin);
window.visualViewport?.addEventListener("scroll", pin);
startLoop();
