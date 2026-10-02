import {
  createState,
  defaultSpecs,
  fitError,
  netOf,
  phaseLabel,
  step,
} from "./sim.js";
import { draw } from "./view.js";

const KEY = "windcart-runs-v1";
const RATES = [1, 4, 8];
const FIELDS = ["wind", "plateW", "plateH", "track", "mass", "outFrac", "vReturn", "turn", "fMax", "cd", "eta", "crr"];

let specs = loadSpecs();
let state = createState(specs);
let running = false;
let rate = 1;
let last = 0;
let runs = loadRuns();
let powerScale = 1500;

const $ = (id) => document.getElementById(id);

function loadSpecs() {
  const base = defaultSpecs();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY + "-specs") || "null");
    if (saved && typeof saved === "object") return { ...base, ...saved };
  } catch (e) {}
  return base;
}

function loadRuns() {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function saveRuns() {
  localStorage.setItem(KEY, JSON.stringify(runs.slice(0, 12)));
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
  $("o-track").textContent = s.track.toFixed(0) + " m";
  $("o-mass").textContent = s.mass.toFixed(0) + " kg";
  const frac = s.outFrac;
  $("o-outFrac").textContent =
    Math.abs(frac - 1 / 3) < 0.012 ? "1/3 wind" : (frac * s.wind).toFixed(1) + " m/s";
  $("o-vReturn").textContent = s.vReturn.toFixed(1) + " m/s";
  $("o-turn").textContent = s.turn.toFixed(1) + " s";
  $("o-fMax").textContent = s.fMax.toFixed(0) + " N";
  $("o-cd").textContent = s.cd.toFixed(2);
  $("o-eta").textContent = Math.round(s.eta * 100) + "%";
  $("o-crr").textContent = s.crr.toFixed(3);
  $("warn").textContent = fitError(s);
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
  let label = running ? phaseLabel(state.phase) : err || "Ready";
  if (running && state.slip) label += " · slipping";
  $("phase").textContent = label;
  $("speed").textContent = state.vx.toFixed(1) + " m/s";
  $("watts").textContent = fmtW(state.inst);
  $("watts").style.color = state.inst >= 0 ? "var(--green)" : "var(--amber)";
  const net = netOf(state);
  $("net").textContent = "net " + fmtKJ(net);
  const avg = state.time > 0.5 ? net / state.time : 0;
  $("substat").textContent =
    state.cycles + (state.cycles === 1 ? " cycle" : " cycles") +
    (state.time > 0.5 ? " · " + Math.round(avg) + " W avg" : "");
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
  const along = state.specs.track > 0 ? (state.x / state.specs.track) * 100 : 0;
  $("map-dot").style.left = Math.max(0, Math.min(100, along)) + "%";
  draw($("view"), state);
}

function changedBits(specs) {
  const d = defaultSpecs();
  const bits = [];
  const far = (k, eps = 1e-4) => Math.abs(Number(specs[k]) - Number(d[k])) > eps;
  if (far("wind")) bits.push(Number(specs.wind).toFixed(1) + " m/s");
  if (far("plateW") || far("plateH")) {
    bits.push(Number(specs.plateW).toFixed(1) + "×" + Number(specs.plateH).toFixed(1) + " m");
  }
  if (far("track")) bits.push(Number(specs.track).toFixed(0) + " m track");
  if (far("mass")) bits.push(Number(specs.mass).toFixed(0) + " kg");
  if (far("outFrac", 0.008)) bits.push("out " + Number(specs.outFrac).toFixed(2));
  if (far("vReturn")) bits.push("ret " + Number(specs.vReturn).toFixed(1));
  if (far("turn")) bits.push("turn " + Number(specs.turn).toFixed(1) + " s");
  if (far("fMax")) bits.push(Number(specs.fMax).toFixed(0) + " N");
  if (far("cd", 0.01)) bits.push("Cd " + Number(specs.cd).toFixed(2));
  if (far("eta", 0.005)) bits.push(Math.round(Number(specs.eta) * 100) + "%");
  if (far("crr", 0.0005)) bits.push("roll " + Number(specs.crr).toFixed(3));
  return bits.length ? bits.join(" · ") : "defaults";
}

function paintRuns() {
  const host = $("runs");
  host.replaceChildren();
  if (!runs.length) {
    const p = document.createElement("p");
    p.className = "substat";
    p.textContent = "Stop a run to keep it.";
    host.appendChild(p);
    return;
  }
  runs.forEach((row, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "run";
    const area = row.plateW * row.plateH;
    const gen = row.gen || 0;
    const mot = row.mot || 0;
    const hold = row.hold || 0;
    btn.innerHTML =
      "<b>" + fmtKJ(row.net) + "</b> · " + Math.round(row.avg) + " W avg" +
      '<span class="meta">' +
      fmtKJ(gen) + " made · " + fmtKJ(-mot) + " home · " + fmtKJ(-hold) + " hold" +
      "</span>" +
      '<span class="meta">' +
      row.cycles + " cyc · " + row.seconds.toFixed(0) + " s · " + area.toFixed(1) + " m² · " +
      changedBits(row.specs || row) +
      "</span>";
    btn.addEventListener("click", () => {
      if (running) return;
      specs = { ...defaultSpecs(), ...row.specs };
      state = createState(specs);
      fillForm();
      paint();
    });
    host.appendChild(btn);
    void i;
  });
}

function record() {
  if (state.time < 0.4) return;
  const net = netOf(state);
  const row = {
    specs: { ...state.specs },
    wind: state.specs.wind,
    plateW: state.specs.plateW,
    plateH: state.specs.plateH,
    mass: state.specs.mass,
    vReturn: state.specs.vReturn,
    cycles: state.cycles,
    seconds: state.time,
    net,
    gen: state.gen,
    mot: state.mot,
    hold: state.hold,
    avg: net / state.time,
  };
  runs.unshift(row);
  runs = runs.slice(0, 12);
  saveRuns();
  paintRuns();
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
    running = true;
    last = 0;
    powerScale = 1500;
    $("run").textContent = "Stop";
    $("run").className = "stop";
  } else {
    running = false;
    record();
    $("run").textContent = "Run";
    $("run").className = "go";
  }
}

$("run").addEventListener("click", () => setRunning(!running));
$("specs-btn").addEventListener("click", () => {
  $("sheet").hidden = !$("sheet").hidden;
});
$("close-specs").addEventListener("click", () => {
  $("sheet").hidden = true;
});
$("defaults").addEventListener("click", () => {
  if (running) return;
  specs = defaultSpecs();
  state = createState(specs);
  fillForm();
  paint();
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
    const next = createState(specs);
    if (running) state.specs = next.specs;
    else state = next;
    paint();
  });
}

fillForm();
paintRuns();
pin();
paint();
window.addEventListener("resize", pin);
window.visualViewport?.addEventListener("resize", pin);
window.visualViewport?.addEventListener("scroll", pin);
requestAnimationFrame(frame);
