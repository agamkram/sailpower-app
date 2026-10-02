import {
  createState,
  defaultSpecs,
  fitError,
  netOf,
  phaseLabel,
  planInfo,
  PRESETS,
  rig,
  sampleCycle,
  solvePlan,
  step,
} from "./sim.js?v=84";
import { draw, bindCam } from "./view.js?v=84";

// v2: mass became chassis-only and eta became converter-only, so specs saved
// under v1 would quietly describe a different machine.
const KEY = "windcart-v2";
const RATES = [1, 4, 8];
const FIELDS = ["wind", "plateW", "plateH", "track", "mass", "outFrac", "vReturn", "turn", "fMax", "cd", "eta", "crr"];

let specs = loadSpecs();
let state = createState(specs);
let running = false;
let rate = 1;
let last = 0;
let powerScale = 1500;
// One settled cycle, cached, so the scrubber has something to slide along.
let cycle = null;
let cycleKey = "";
let scrub = null;

const $ = (id) => document.getElementById(id);

function loadSpecs() {
  const base = defaultSpecs();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-specs") || "null");
    if (saved && typeof saved === "object") return { ...base, ...saved };
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
  paintPlan(s);
}

function paintPlan(s) {
  const lead = s.turnLead ?? 0;
  for (const btn of $("plan-chips").children) {
    const on = Math.abs(Number(btn.dataset.lead) - lead) < 0.01;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
  const p = planInfo(s);
  $("plan-note").textContent =
    `turn ${p.turn.toFixed(2)}s · lead ${p.lead.toFixed(2)}s · ` +
    `brake ${p.brakeM.toFixed(1)}m · ${Math.round(p.torqueNm)} Nm`;
}

function buildPlan() {
  const host = $("plan-chips");
  host.replaceChildren();
  for (const p of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = p.name;
    btn.dataset.lead = String(p.turnLead);
    btn.setAttribute("role", "radio");
    btn.addEventListener("click", () => {
      specs = { ...specs, turnLead: p.turnLead };
      dropCycle();
      // A running sim reads its own copy of the specs, so the choice has to be
      // handed to it the same way a slider does or the chip lights up and
      // nothing on the rail changes.
      if (running) state.specs = specs;
      else state = createState(specs);
      paintPlan(specs);
      if (scrub != null) applyScrub(scrub);
      else paint();
    });
    host.appendChild(btn);
  }
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
  const err = fitError(state.specs);
  const live = running || scrub != null;
  let label = live ? phaseLabel(state.phase) : err || "Ready";
  if (live && state.feather > 0.02) {
    label += " · feathered " + Math.round((state.feather * 180) / Math.PI) + "°";
  }
  if (live && state.slip) label += " · slipping";
  $("phase").textContent = label;
  $("speed").textContent = state.vx.toFixed(1) + " m/s";
  $("watts").textContent = fmtW(state.inst);
  $("watts").style.color = state.inst >= 0 ? "var(--green)" : "var(--amber)";
  const net = netOf(state);
  const dur = cycle ? cycle.seconds : state.lastCycleS;
  if (scrub != null) {
    $("net").textContent = (scrub * dur).toFixed(2) + " s";
    $("substat").textContent = dur > 0 ? "of a " + dur.toFixed(1) + " s cycle" : "no cycle";
  } else {
    $("net").textContent = "net " + fmtKJ(net);
    const avg = state.time > 0.5 ? net / state.time : 0;
    $("substat").textContent =
      state.cycles + (state.cycles === 1 ? " cycle" : " cycles") +
      (state.time > 0.5 ? " · " + Math.round(avg) + " W avg" : "");
  }
  powerScale = Math.max(800, powerScale * 0.998, Math.abs(state.inst) * 1.25);
  const span = powerScale;
  const pct = Math.max(-50, Math.min(50, (state.inst / span) * 50));
  const fill = $("pfill");
  if (pct >= 0) {
    fill.style.left = "50%";
    fill.style.width = pct + "%";
    fill.style.background = "var(--green)";
  } else {
    fill.style.left = 50 + pct + "%";
    fill.style.width = -pct + "%";
    fill.style.background = "var(--amber)";
  }
  let frac;
  if (scrub != null) frac = scrub;
  else if (dur > 0) frac = Math.min(1, state.cycleT / dur);
  else frac = 0;
  const pctAlong = Math.max(0, Math.min(100, frac * 100));
  $("map-dot").style.left = pctAlong + "%";
  $("track-map").setAttribute("aria-valuenow", Math.round(pctAlong));
  draw($("view"), state);
}

function frame(t) {
  if (running) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    if (dt > 0) step(state, dt * rate);
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
    powerScale = 1500;
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
    specs = { ...base, outFrac: plan.outFrac, turn: plan.turn, turnLead: plan.turnLead };
    dropCycle();
    clearScrub();
    state = createState(specs);
    fillForm();
    paint();
    $("warn").textContent = "Best found: " + Math.round(plan.avgW) + " W average";
  } finally {
    btn.textContent = "Solve";
    btn.disabled = false;
  }
});
$("rate").addEventListener("click", () => {
  const i = RATES.indexOf(rate);
  rate = RATES[(i + 1) % RATES.length];
  $("rate").textContent = rate + "×";
});
for (const id of FIELDS) {
  $(id).addEventListener("input", () => {
    paintForm();
    specs = readForm();
    dropCycle();
    const next = createState(specs);
    if (running) state.specs = next.specs;
    else state = next;
    if (!running && scrub != null) applyScrub(scrub);
    else paint();
  });
}

buildPlan();
fillForm();
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
