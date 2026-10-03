/** Side view of the machine. Face-on sail is the thin plate. Edge-on sail faces the camera. */

import { stroke } from "./sim.js?v=115";

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a) {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
function hex(n) {
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgb(${r|0},${g|0},${b|0})`;
}
function shade(n, k) {
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) * k));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) * k));
  const b = Math.max(0, Math.min(255, (n & 255) * k));
  return (r << 16) | (g << 8) | b;
}
function yawXZ(x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c - z * s, x * s + z * c];
}

const RAIL = 0xc43238;
const RUNG = 0x9a241c;
const FRAME = 0x8b97a6;
const FRAME_DK = 0x66717f;
const WHEEL = 0xd7dee8;
const HUB = 0x1b212b;
const PLATE = 0x1a1d20;
const MOTOR = 0x3e4a5c;
const MOTOR_CAP = 0x1a212b;
const RING = 0xb7c0ca;
const STEEL = 0x3c4654;
const TOOTH = 0x6a7686;
const SKATE_ON = 0xe2b340;
const SKATE_MOT = 0x6eb6e0;
const STOP = 0x6e1218;

let followX = null;

// Free-stream markers. The watts do not use them. While the sim is running they
// share its clock, including the rate button. While it is paused they keep
// drifting on the wall clock so the slider still shows.
const windParts = [];
const windSmoke = [];
const windDraw = [];
let windWall = 0;
let windSim = null;
let windClock = 0;

function windDt(st) {
  const now = performance.now() / 1000;
  const wall = windWall ? Math.min(0.05, now - windWall) : 0.016;
  windWall = now;
  if (windSim == null || st.time + 0.05 < windSim) {
    windSim = st.time;
    return wall;
  }
  if (st.time > windSim + 1e-4) {
    const dt = Math.min(0.25, st.time - windSim);
    windSim = st.time;
    return dt;
  }
  windSim = st.time;
  return wall;
}

function reseedWind(p, xLo, xHi, sailTop, atSail, inlet) {
  p.ox = 0;
  p.oy = 0;
  p.oz = 0;
  p.a = 0.35 + Math.random() * 0.4;
  p.y = 0.4 + Math.random() * (sailTop + 1.1);
  p.z = (Math.random() - 0.5) * (atSail ? 4.4 : 9);
  // Leaving the frame comes back in at the upstream edge, the way a tracer
  // would. Scattering the replacement through the volume fed the slow wake.
  p.x = inlet ? xLo : xLo + Math.random() * Math.max(1, xHi - xLo);
  if (atSail) p.y = 0.7 + Math.random() * Math.max(0.5, sailTop - 0.4);
}

/**
 * Picture of the air around the plate. The force model is not touched.
 *
 * In coordinates stretched so the plate's outline is a unit circle, each term
 * comes from an axisymmetric stream function: a centreline gaussian for the
 * cushion, the bubble and the wake, and a ring gaussian for the rim. The
 * radial velocity is the one that cancels the streamwise divergence, so the
 * grains cannot pile up where the air slows. A traveling wave in the
 * horizontal plane, also drawn from a stream function, sheds across the width
 * at a Strouhal number of 0.15. Edge-on, the projected width collapses and
 * the wave is faded out, so the plate throws nothing.
 */
function sailFlow(p, sail) {
  const Um = Math.abs(sail.U);
  if (Um < 0.15) return [0, 0, 0];
  const face = Math.abs(Math.cos(sail.yaw));
  const edge = Math.abs(Math.sin(sail.yaw));
  let gate = (face - 0.1) / 0.25;
  if (gate <= 0) return [0, 0, 0];
  if (gate > 1) gate = 1;
  gate = gate * gate * (3 - 2 * gate);
  const Wp = sail.halfW * face + (sail.thick || 0.006) * 0.5 * edge;
  if (Wp < 0.04) return [0, 0, 0];
  const H = Math.max(0.2, sail.halfH);
  const R0 = 2 * Wp;
  const dir = Math.sign(sail.U) || 1;
  const xi = ((p.x - sail.bx) * dir) / R0;
  const Y = (p.y - sail.midY) / H;
  const Z = p.z / Wp;
  const rho = Math.hypot(Y, Z);

  let uxi = 0;
  let ur = 0;
  const gauss = (M, x0, sx, sr) => {
    const dx = xi - x0;
    const sx2 = sx * sx;
    const A = M * Math.exp((-0.5 * dx * dx) / sx2);
    const Ap = (A * -dx) / sx2;
    const sr2 = sr * sr;
    const a = (rho * rho) / (2 * sr2);
    const e = Math.exp(-a);
    uxi += A * e;
    if (rho < 1e-3) ur += -Ap * rho * 0.5;
    else ur += -Ap * (sr2 / rho) * (1 - e);
  };
  const rim = (M, x0, sx, sr) => {
    const dx = xi - x0;
    const sx2 = sx * sx;
    const A = M * Math.exp((-0.5 * dx * dx) / sx2);
    const Ap = (A * -dx) / sx2;
    const sr2 = sr * sr;
    const a = (rho * rho) / (2 * sr2);
    const e = Math.exp(-a);
    uxi += A * rho * rho * e;
    const bracket = 1 - e * (a + 1);
    if (rho < 1e-3) ur += -Ap * rho * rho * rho * 0.25;
    else ur += -Ap * ((2 * sr2 * sr2) / rho) * bracket;
  };

  // Fractions of the relative wind. ξ is in projected widths. The cushion is
  // centred just behind the face, so on the plate itself the air is still
  // spreading toward the rim rather than sitting at the stagnation line.
  gauss(-0.55, 0.22, 0.42, 0.58);
  rim(2.05, -0.06, 0.3, 0.707);
  gauss(-1.7, 1.2, 0.48, 0.38);
  gauss(-0.28, 2.6, 1.15, 0.75);
  gauss(-0.16, 5.5, 2, 1.1);
  gauss(-0.09, 10, 3, 1.5);

  const k = (2 * Math.PI) / 5.3;
  const L = 8;
  const w = 0.4;
  const sz = 0.6;
  const sy = 0.75;
  const eps = 0.16;
  const freq = (0.15 * Um) / R0;
  const ang = k * xi - 2 * Math.PI * freq * (sail.time || 0);
  const Sig = 1 / (1 + Math.exp(-xi / w));
  const env = Sig * Math.exp(-xi / L);
  const envp = env * ((1 - Sig) / w - 1 / L);
  const S = Math.sin(ang);
  const C = Math.cos(ang);
  const Gz = Math.exp((-0.5 * Z * Z) / (sz * sz));
  const Gy = Math.exp((-0.5 * Y * Y) / (sy * sy));
  const phiX = Gy * eps * S * env * Gz * (-Z / (sz * sz));
  const phiZ = Gy * -eps * Gz * (k * C * env + S * envp);

  const inv = rho < 1e-4 ? 0 : 1 / rho;
  const scale = Um * gate;
  const vxi = scale * (uxi + phiX);
  const vy = scale * (H / R0) * (ur * Y * inv);
  const vz = scale * (Wp / R0) * (ur * Z * inv + phiZ);
  return [dir * vxi, vy, vz];
}

/**
 * Upstream grains go around the plate, so they never enter the separated
 * region. A few are released there, into the same field, so the reverse flow
 * can be seen. They are put back when they leave that region.
 */
function smokeGeom(sail) {
  const face = Math.abs(Math.cos(sail.yaw));
  const edge = Math.abs(Math.sin(sail.yaw));
  const Wp = sail.halfW * face + (sail.thick || 0.006) * 0.5 * edge;
  const H = Math.max(0.2, sail.halfH);
  return { face, Wp, H, R0: 2 * Wp, dir: Math.sign(sail.U) || 1 };
}

function smokeInside(p, sail) {
  const g = smokeGeom(sail);
  if (g.face < 0.2 || g.Wp < 0.04) return false;
  const xi = ((p.x - sail.bx) * g.dir) / g.R0;
  const rho = Math.hypot((p.y - sail.midY) / g.H, p.z / g.Wp);
  return xi > 0.2 && xi < 3.4 && rho < 1.2 && p.y > 0.25;
}

function seedSmoke(p, sail) {
  const g = smokeGeom(sail);
  const ang = Math.random() * Math.PI * 2;
  const rho = 0.22 + Math.random() * 0.4;
  const xi = 0.5 + Math.random() * 0.55;
  p.x = sail.bx + g.dir * xi * g.R0;
  p.y = sail.midY + Math.cos(ang) * rho * g.H;
  p.z = Math.sin(ang) * rho * g.Wp;
  p.a = 0.45 + Math.random() * 0.4;
}

/** A step that lands inside the plate is put back on the windward face. */
function holdOffPlate(p, sail) {
  const c = Math.cos(sail.yaw);
  if (Math.abs(c) < 0.2 || Math.abs(sail.U) < 0.15) return;
  const sn = Math.sin(sail.yaw);
  const dx = p.x - sail.bx;
  const lx = dx * c + p.z * sn;
  const ly = p.y - sail.midY;
  const lz = -dx * sn + p.z * c;
  if (Math.abs(lx) > 0.22) return;
  if (Math.abs(ly) >= sail.halfH || Math.abs(lz) >= sail.halfW) return;
  // The outer band is the rim. Holding it on the face stacked grains there.
  const ny = ly / sail.halfH;
  const nz = lz / sail.halfW;
  if (ny * ny + nz * nz > 0.72) return;
  const up = Math.sign(sail.U * c) || 1;
  const lx2 = -0.04 * up;
  p.x = sail.bx + lx2 * c - lz * sn;
  p.z = lx2 * sn + lz * c;
}


const CAM0 = {
  yaw: Math.atan2(-1.7, 7.78),
  pitch: Math.asin(2.55 / Math.hypot(1.7, 2.55, 7.78)),
  dist: Math.hypot(1.7, 2.55, 7.78),
};
const FOV = 0.98;
const camCtl = { yaw: CAM0.yaw, pitch: CAM0.pitch, dist: CAM0.dist };
// False until the user orbits or pinches. The home view frames the whole run.
let camHeld = false;

export function resetCam() {
  camHeld = false;
  camCtl.yaw = CAM0.yaw;
  camCtl.pitch = CAM0.pitch;
}

function projectHome(dist, target, p, w, h) {
  const cp = Math.cos(CAM0.pitch);
  const sp = Math.sin(CAM0.pitch);
  const cy = Math.cos(CAM0.yaw);
  const sy = Math.sin(CAM0.yaw);
  const eye = [
    target[0] + dist * cp * sy,
    target[1] + dist * sp,
    target[2] + dist * cp * cy,
  ];
  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const fLen = h / 2 / Math.tan(FOV / 2);
  const d = sub(p, eye);
  const depth = -dot(d, zaxis);
  if (depth < 0.2) return null;
  return {
    x: w / 2 + (dot(d, xaxis) / depth) * fLen,
    y: h / 2 - (dot(d, yaxis) / depth) * fLen,
  };
}

/** Smallest distance that keeps both caps and the sail inside the home view. */
function homeDist(s, w, h, target, lo, hi, cap0, cap1, sailTop) {
  const hz = Math.max(0.6, s.plateW / 2);
  const hx = s.plateW / 2;
  const pts = [
    [cap0, 0.15, 0],
    [cap1, 0.15, 0],
    [lo - hx, sailTop + 0.2, -hz],
    [lo - hx, sailTop + 0.2, hz],
    [hi + hx, sailTop + 0.2, -hz],
    [hi + hx, sailTop + 0.2, hz],
  ];
  const marginX = w * 0.06;
  const marginY = h * 0.07;
  const covers = (dist) => {
    for (const p of pts) {
      const q = projectHome(dist, target, p, w, h);
      if (!q) return false;
      if (q.x < marginX || q.x > w - marginX || q.y < marginY || q.y > h - marginY) return false;
    }
    return true;
  };
  let loD = 3.2;
  let hiD = 72;
  if (!covers(hiD)) return hiD;
  for (let i = 0; i < 12; i++) {
    const mid = (loD + hiD) / 2;
    if (covers(mid)) hiD = mid;
    else loD = mid;
  }
  return hiD;
}

export function bindCam(canvas, onChange) {
  const pointers = new Map();
  let mode = null;
  let lastX = 0;
  let lastY = 0;
  let lastPinch = 0;
  let lastTap = 0;

  function ptDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function clampCam() {
    camCtl.pitch = Math.max(0.08, Math.min(1.35, camCtl.pitch));
    camCtl.dist = Math.max(3.2, Math.min(72, camCtl.dist));
  }
  function fire() {
    camHeld = true;
    clampCam();
    onChange?.();
  }

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        mode = "orbit";
        lastX = e.clientX;
        lastY = e.clientY;
        const now = performance.now();
        if (now - lastTap < 280) {
          resetCam();
          onChange?.();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      } else if (pointers.size === 2) {
        mode = "pinch";
        const pts = [...pointers.values()];
        lastPinch = ptDist(pts[0], pts[1]);
        lastTap = 0;
      }
      e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === "orbit" && pointers.size === 1) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        camCtl.yaw -= dx * 0.0055;
        camCtl.pitch += dy * 0.0042;
        fire();
      } else if (mode === "pinch" && pointers.size >= 2) {
        const pts = [...pointers.values()];
        const d = ptDist(pts[0], pts[1]);
        if (lastPinch > 1) {
          camCtl.dist *= lastPinch / d;
          fire();
        }
        lastPinch = d;
      }
      e.preventDefault();
    },
    { passive: false }
  );

  function endPtr(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) mode = null;
    else if (pointers.size === 1) {
      mode = "orbit";
      const p = [...pointers.values()][0];
      lastX = p.x;
      lastY = p.y;
    }
  }
  canvas.addEventListener("pointerup", endPtr);
  canvas.addEventListener("pointercancel", endPtr);
  canvas.addEventListener("pointerleave", (e) => {
    if (pointers.has(e.pointerId) && e.pointerType === "mouse") endPtr(e);
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      camCtl.dist *= e.deltaY > 0 ? 1.08 : 0.92;
      fire();
      e.preventDefault();
    },
    { passive: false }
  );
}

export function draw(canvas, st) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#161d28");
  sky.addColorStop(0.45, "#0d1219");
  sky.addColorStop(1, "#070a0e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const s = st.specs;
  followX = st.x;

  // Looking higher than the old 1.35 aim drops the track in the frame.
  // Extra sail height lifts the aim again, so the top stays inside and the
  // track drops with it. The home view frames the whole run, so the cart
  // travels instead of sitting still while the sail spins. Pinch in and the
  // view follows the cart again.
  const sailTop = 0.61 + s.plateH;
  const aimY = 1.75 + Math.max(0, sailTop - 2.61) * 0.55;
  const { cap0, cap1, lo, hi } = stroke(s);
  const midX = (cap0 + cap1) / 2;
  const homeTarget = [midX, aimY, 0];
  const fitted = homeDist(s, w, h, homeTarget, lo, hi, cap0, cap1, sailTop);
  if (!camHeld) camCtl.dist = fitted;
  let follow = 0;
  if (camHeld) {
    const near = fitted * 0.55;
    const far = fitted * 0.85;
    follow = Math.min(1, Math.max(0, (far - camCtl.dist) / Math.max(0.2, far - near)));
  }
  const target = [midX + (followX + 0.35 - midX) * follow, aimY, 0];
  const cp = Math.cos(camCtl.pitch);
  const sp = Math.sin(camCtl.pitch);
  const cy = Math.cos(camCtl.yaw);
  const sy = Math.sin(camCtl.yaw);
  const eye = [
    target[0] + camCtl.dist * cp * sy,
    target[1] + camCtl.dist * sp,
    target[2] + camCtl.dist * cp * cy,
  ];
  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const fLen = h / 2 / Math.tan(FOV / 2);
  const cam = { eye, xaxis, yaxis, zaxis, fLen, w, h };

  const polys = [];
  function depthOf(p) {
    return -dot(sub(p, cam.eye), cam.zaxis);
  }
  function project(p) {
    const d = sub(p, cam.eye);
    const depth = -dot(d, cam.zaxis);
    if (depth < 0.05) return null;
    return {
      x: w / 2 + (dot(d, cam.xaxis) / depth) * cam.fLen,
      y: h / 2 - (dot(d, cam.yaxis) / depth) * cam.fLen,
      z: depth,
    };
  }
  function add(pts, color, layer = 0) {
    let zMin = Infinity;
    for (const p of pts) {
      const d = depthOf(p);
      if (d < zMin) zMin = d;
    }
    if (zMin < 0.35) return;
    const proj = [];
    let z = 0;
    for (const p of pts) {
      const q = project(p);
      if (!q) return;
      proj.push(q);
      z += q.z;
    }
    const allOut = proj.every(
      (q) => q.x < -w * 0.75 || q.x > w * 1.75 || q.y < -h * 0.75 || q.y > h * 1.75
    );
    if (allOut) return;
    let area = 0;
    let maxEdge = 0;
    for (let i = 0; i < proj.length; i++) {
      const a = proj[i];
      const b = proj[(i + 1) % proj.length];
      const edge = Math.hypot(b.x - a.x, b.y - a.y);
      if (edge > maxEdge) maxEdge = edge;
      area += a.x * b.y - b.x * a.y;
    }
    area = Math.abs(area) * 0.5;
    if (area < 0.35) return;
    if (maxEdge > Math.hypot(w, h) * 1.8) return;
    // Track sits a hair further away so it loses ties against the cart that
    // rides on it, rather than being painted over the top of everything.
    polys.push({ proj, color, z: z / proj.length + layer * 0.02, layer });
  }
  function ring(c, axis, r, off, spin, n = 10) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + spin;
      const cs = Math.cos(a) * r;
      const sn = Math.sin(a) * r;
      if (axis === "z") pts.push([c[0] + cs, c[1] + sn, c[2] + off]);
      else if (axis === "y") pts.push([c[0] + cs, c[1] + off, c[2] + sn]);
      else pts.push([c[0] + off, c[1] + cs, c[2] + sn]);
    }
    return pts;
  }
  // Outward normal of a quad wound like the tube facets. Used to drop the
  // back of a rail: that skin shares the front's depth, so as the camera
  // pans it paints over the outside and the joint reads as a moving line.
  function facing(quad) {
    const ax = quad[1][0] - quad[0][0];
    const ay = quad[1][1] - quad[0][1];
    const az = quad[1][2] - quad[0][2];
    const bx = quad[2][0] - quad[0][0];
    const by = quad[2][1] - quad[0][1];
    const bz = quad[2][2] - quad[0][2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const ex = cam.eye[0] - quad[0][0];
    const ey = cam.eye[1] - quad[0][1];
    const ez = cam.eye[2] - quad[0][2];
    return nx * ex + ny * ey + nz * ez > 0;
  }
  function wheel(c, axis, r, width, color, spin = 0, spokes = false, open = false, layer = 0, cull = false) {
    const N = 10;
    const rings = [-width / 2, width / 2].map((off) => ring(c, axis, r, off, spin));
    if (!open) {
      add(rings[0], shade(color, 1.08), layer);
      add(rings[1], shade(color, 0.72), layer);
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const quad = [rings[0][i], rings[0][j], rings[1][j], rings[1][i]];
      if (cull && !facing(quad)) continue;
      add(quad, shade(color, 0.9), layer);
    }
    if (!spokes) return;
    for (let k = 0; k < 3; k++) {
      const a = spin + (k * Math.PI) / 3;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const u = 0.012;
      let p0;
      let p1;
      let q0;
      let q1;
      if (axis === "z") {
        p0 = [c[0] + cs * 0.012, c[1] + sn * 0.012, c[2]];
        p1 = [c[0] + cs * r * 0.78, c[1] + sn * r * 0.78, c[2]];
        q0 = [p0[0] - sn * u, p0[1] + cs * u, c[2]];
        q1 = [p1[0] - sn * u, p1[1] + cs * u, c[2]];
      } else if (axis === "y") {
        p0 = [c[0] + cs * 0.012, c[1], c[2] + sn * 0.012];
        p1 = [c[0] + cs * r * 0.78, c[1], c[2] + sn * r * 0.78];
        q0 = [p0[0] - sn * u, c[1], p0[2] + cs * u];
        q1 = [p1[0] - sn * u, c[1], p1[2] + cs * u];
      } else {
        continue;
      }
      add([p0, q0, q1, p1], HUB);
    }
  }
  function box(cx, cy, cz, sx, sy, sz, yaw, color, layer = 0) {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const P = [];
    for (const x of [-hx, hx]) {
      for (const y of [-hy, hy]) {
        for (const z of [-hz, hz]) {
          P.push([cx + x * c - z * sn, cy + y, cz + x * sn + z * c]);
        }
      }
    }
    const faces = [
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
      [0, 2, 3, 1],
      [4, 5, 7, 6],
    ];
    const ks = [0.62, 1.08, 0.78, 0.92, 0.7, 0.98];
    faces.forEach((face, i) => add(face.map((k) => P[k]), shade(color, ks[i]), layer));
  }

  const railR = 0.05;
  const railY = 0.2;
  const gauge = s.gauge;
  const bx = st.x;
  const spin = -st.x / 0.062;

  // Where the view meets the rail plane. The old window was a fixed few
  // metres, which is why the rails stopped at the edge of the ground shadow.
  function railHitX(sx, sy) {
    const nx = (sx - w / 2) / cam.fLen;
    const ny = (h / 2 - sy) / cam.fLen;
    const vx = cam.xaxis[0] * nx + cam.yaxis[0] * ny - cam.zaxis[0];
    const vy = cam.xaxis[1] * nx + cam.yaxis[1] * ny - cam.zaxis[1];
    if (Math.abs(vy) < 1e-4) return null;
    const t = (railY - cam.eye[1]) / vy;
    if (t < 0.02) return null;
    const x = cam.eye[0] + t * vx;
    if (Math.abs(x - followX) > 80) return null;
    return x;
  }
  let xLo = Infinity;
  let xHi = -Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = railHitX(-w * 0.12 + (w * 1.24 * i) / 4, (h * 1.08 * j) / 4);
      if (x == null) continue;
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
  }
  if (!(xHi > xLo)) {
    xLo = followX - 12;
    xHi = followX + 12;
  }
  const rail0 = Math.max(cap0 - 0.05, xLo);
  const rail1 = Math.min(cap1 + 0.05, xHi);

  // Keep every rung. Dropping the ones near the cart made the ladder vanish
  // under the bogie and pop back in once it had passed.
  const rungPitch = 0.4;
  for (let x = Math.ceil(rail0 / rungPitch) * rungPitch; x < rail1; x += rungPitch) {
    if (x < cap0 + 0.05 || x > cap1 - 0.05) continue;
    wheel([x, railY - 0.012, 0], "z", 0.02, gauge - railR * 2 - 0.02, RUNG, 0, false, true, 2, true);
  }

  if (rail0 <= cap0 + 0.4) box(cap0, railY + 0.1, 0, 0.07, 0.32, gauge + 0.16, 0, STOP);
  if (rail1 >= cap1 - 0.4) box(cap1, railY + 0.1, 0, 0.07, 0.32, gauge + 0.16, 0, STOP);

  const rails = [
    { y: railY, z: -gauge / 2, r: railR, color: RAIL },
    { y: railY, z: gauge / 2, r: railR, color: RAIL },
    { y: railY, z: 0, r: 0.026, color: 0xc5d2df },
  ];

  const topR = 0.058;
  const sideR = 0.032;
  const botR = 0.042;
  const topY = railY + railR + topR;
  const botY = railY - railR - botR;
  const axles = [-0.26, 0.26];

  for (const z of [-gauge / 2, gauge / 2]) {
    const side = z > 0 ? 1 : -1;
    const fz = z - side * 0.07;
    box(bx, topY, fz, 0.64, 0.016, 0.014, 0, FRAME);
    box(bx, botY, fz, 0.64, 0.014, 0.012, 0, FRAME);
    box(bx, railY, fz, 0.5, 0.012, 0.012, 0, FRAME_DK);
    for (const dx of axles) {
      box(bx + dx, (topY + botY) / 2, fz, 0.014, topY - botY + 0.02, 0.012, 0, FRAME);
      box(bx + dx, topY, (z + fz) / 2, 0.016, 0.016, Math.abs(z - fz), 0, FRAME_DK);
      box(bx + dx, botY, (z + fz) / 2, 0.014, 0.014, Math.abs(z - fz), 0, FRAME_DK);
      wheel([bx + dx, topY, z], "z", topR, 0.026, WHEEL, spin, true);
      wheel([bx + dx, topY, z], "z", 0.018, 0.03, HUB, spin, false);
      wheel([bx + dx, botY, z], "z", botR, 0.022, WHEEL, spin, true);
      wheel([bx + dx, botY, z], "z", 0.014, 0.026, HUB, spin, false);
    }
    for (const dx of [-0.06, 0.06]) {
      const sz = z + side * (railR + sideR);
      wheel([bx + dx, railY, sz], "y", sideR, 0.018, WHEEL, spin * 0.4, false);
      box(bx + dx, railY, (sz + fz) / 2, 0.012, 0.012, Math.abs(sz - fz), 0, FRAME_DK);
    }
  }

  box(bx - 0.26, topY + 0.035, 0, 0.016, 0.016, gauge - 0.14, 0, FRAME);
  box(bx + 0.26, topY + 0.035, 0, 0.016, 0.016, gauge - 0.14, 0, FRAME);
  box(bx, topY + 0.055, 0, 0.62, 0.016, 0.03, 0, FRAME);

  const deckY = topY + 0.1;
  box(bx, deckY, 0, 0.24, 0.02, 0.2, 0, FRAME);

  const generating = st.inst > 30;
  const motoring = st.inst < -30;
  const mag = generating ? SKATE_ON : motoring ? SKATE_MOT : 0x9aa6b4;
  // Proud of the center bar, and a nearer layer, so they cover it instead
  // of sharing its surface. Sharing it was the blink. Two of the five are
  // the bright pair; the other three stay the darker shade of the same
  // state, gold while generating and blue while motoring.
  for (let i = -2; i <= 2; i++) {
    box(
      bx + i * 0.07,
      railY,
      0,
      0.05,
      0.064,
      0.078,
      0,
      i % 2 ? mag : shade(mag, 0.55),
      1
    );
  }

  const yaw = st.alpha;
  wheel([bx, deckY + 0.045, 0], "y", 0.105, 0.04, RING, yaw, true);
  wheel([bx, deckY + 0.045, 0], "y", 0.045, 0.05, HUB, yaw, false);
  for (let k = 0; k < 4; k++) {
    const a = yaw + (k * Math.PI) / 2;
    const [lx, lz] = yawXZ(0, 0.078, a);
    box(bx + lx, deckY + 0.07, lz, 0.028, 0.02, 0.05, a, RING);
  }

  const mz = 0.24;
  box(bx - 0.02, deckY + 0.06, mz, 0.1, 0.09, 0.1, 0, MOTOR);
  wheel([bx + 0.1, deckY + 0.06, mz], "x", 0.042, 0.2, MOTOR, 0, false);
  wheel([bx + 0.21, deckY + 0.06, mz], "x", 0.046, 0.03, MOTOR_CAP, 0, false);
  for (let i = 0; i < 4; i++) {
    wheel([bx + 0.02 + i * 0.045, deckY + 0.06, mz], "x", 0.05, 0.01, shade(MOTOR, 1.25), 0, false);
  }
  wheel([bx - 0.02, deckY + 0.05, 0.14], "y", 0.032, 0.04, HUB, yaw * 3, true);

  const py0 = deckY + 0.2;
  const py1 = py0 + s.plateH;
  const midY = (py0 + py1) / 2;
  box(bx, (deckY + py0) / 2, 0, 0.04, py0 - deckY - 0.02, 0.04, yaw, FRAME);
  // Strips keep a near corner from sorting over the whole track. They
  // overlap so the join antialiases onto the same grey, instead of a dark
  // crack that opens and closes as the camera moves. No separate edge rail:
  // that rail was charcoal, and only parts of it won the sort.
  {
    const hx = 0.012;
    const hy = s.plateH / 2;
    const hz = s.plateW / 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const corner = (x, y, z) => [bx + x * c - z * sn, midY + y, x * sn + z * c];
    const strips = 8;
    const lap = 0.04;
    // Only the face toward the camera. The far skin is a darker grey a
    // centimetre behind, and from some angles its edge paints over the
    // near border as a charcoal line.
    const facingFront = c * (cam.eye[0] - bx) + sn * cam.eye[2] >= 0;
    const xSkin = facingFront ? hx : -hx;
    const tone = 1;
    for (let i = 0; i < strips; i++) {
      let z0 = -hz + (i / strips) * s.plateW;
      let z1 = -hz + ((i + 1) / strips) * s.plateW;
      if (i > 0) z0 -= lap;
      if (i < strips - 1) z1 += lap;
      const skin = facingFront
        ? [corner(xSkin, -hy, z0), corner(xSkin, -hy, z1), corner(xSkin, hy, z1), corner(xSkin, hy, z0)]
        : [corner(xSkin, -hy, z0), corner(xSkin, hy, z0), corner(xSkin, hy, z1), corner(xSkin, -hy, z1)];
      add(skin, shade(PLATE, tone));
    }
  }

  // One outline per rail. A tube built from facets has a joint every piece
  // and a flat on every side, and both of those move when the camera does.
  function strokeRail(y, z, r, color, from, to) {
    const step = 0.2;
    const pts = [];
    for (let x = from; x <= to + 1e-4; x += step) {
      const at = Math.min(x, to);
      const c = project([at, y, z]);
      const up = project([at, y + r, z]);
      if (!c || !up) continue;
      pts.push({
        x: c.x,
        y: c.y,
        rad: Math.max(0.6, Math.hypot(up.x - c.x, up.y - c.y)),
      });
    }
    if (pts.length < 2) return;
    const left = [];
    const right = [];
    let px = 0;
    let py = -1;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      let qx = -ty;
      let qy = tx;
      if (qx * px + qy * py < 0) {
        qx = -qx;
        qy = -qy;
      }
      px = qx;
      py = qy;
      const s = pts[i];
      left.push([s.x + qx * s.rad, s.y + qy * s.rad]);
      right.push([s.x - qx * s.rad, s.y - qy * s.rad]);
    }
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fillStyle = hex(color);
    ctx.fill();
  }

  // Grains fill the framed track. A circle reads as a ball, so these stay square.
  {
    const dt = windDt(st);
    const speed = Math.max(0, s.wind);
    const sailAir = py1;
    const xLo = rail0 - 1;
    const xHi = rail1 + 1;
    const count = Math.min(2200, Math.round(Math.max(8, xHi - xLo) * 90));
    while (windParts.length < count) {
      const p = { x: 0, y: 0, z: 0, ox: 0, oy: 0, oz: 0, a: 0.5 };
      reseedWind(p, xLo, xHi, sailAir, windParts.length % 2 === 0);
      windParts.push(p);
    }
    windClock += dt;
    const sail = {
      bx,
      midY,
      yaw,
      halfH: s.plateH / 2,
      halfW: s.plateW / 2,
      thick: s.thickness,
      U: speed - st.vx,
      time: windClock,
    };
    windDraw.length = 0;
    for (let i = 0; i < count; i++) {
      const p = windParts[i];
      const wash = sailFlow(p, sail);
      p.ox = wash[0];
      p.oy = wash[1];
      p.oz = wash[2];
      p.x += (speed + p.ox) * dt;
      p.y += p.oy * dt;
      p.z += p.oz * dt;
      holdOffPlate(p, sail);
      if (p.x > xHi || p.x < xLo || p.y > sailAir + 2.4 || p.y < 0.15) {
        reseedWind(p, xLo, xHi, sailAir, false, true);
      }
      const q = project([p.x, p.y, p.z]);
      if (!q || q.z < 0.4) continue;
      windDraw.push({ p, q, z: q.z });
    }
    // Separated-region grains. Same field as the free stream.
    if (Math.abs(Math.cos(yaw)) > 0.2 && Math.abs(sail.U) > 0.15) {
      while (windSmoke.length < 48) windSmoke.push({ x: 0, y: -10, z: 0, a: 0.5, live: false });
      for (const p of windSmoke) {
        if (!p.live || !smokeInside(p, sail)) {
          seedSmoke(p, sail);
          p.live = true;
        }
        const wash = sailFlow(p, sail);
        p.x += (speed + wash[0]) * dt;
        p.y += wash[1] * dt;
        p.z += wash[2] * dt;
        const q = project([p.x, p.y, p.z]);
        if (!q || q.z < 0.4) continue;
        windDraw.push({ p, q, z: q.z });
      }
    }
    ctx.save();
    ctx.fillStyle = "rgb(214, 230, 240)";
    for (const dot of windDraw) {
      if (dot.z < depthOf([bx, midY, 0]) - 0.05) continue;
      paintGrain(ctx, dot, dpr);
    }
    ctx.restore();
  }

  // Far rail first, then the meshes, so the cart and the coils cover the bar.
  rails.sort((a, b) => depthOf([bx, b.y, b.z]) - depthOf([bx, a.y, a.z]));
  for (const rail of rails) strokeRail(rail.y, rail.z, rail.r, rail.color, rail0, rail1);

  polys.sort((a, b) => b.z - a.z || b.layer - a.layer);
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(poly.proj[0].x, poly.proj[0].y);
    for (let i = 1; i < poly.proj.length; i++) ctx.lineTo(poly.proj[i].x, poly.proj[i].y);
    ctx.closePath();
    ctx.fillStyle = hex(poly.color);
    ctx.fill();
  }

  // Grains that have spilled past the plate and sit closer than it.
  ctx.save();
  ctx.fillStyle = "rgb(214, 230, 240)";
  const sailDepth = depthOf([bx, midY, 0]);
  const wc = Math.cos(yaw);
  const ws = Math.sin(yaw);
  for (const dot of windDraw) {
    if (dot.z > sailDepth - 0.05) continue;
    const p = dot.p;
    const ly = p.y - midY;
    const lz = -(p.x - bx) * ws + p.z * wc;
    if (Math.abs(ly) < s.plateH / 2 && Math.abs(lz) < s.plateW / 2) continue;
    paintGrain(ctx, dot, dpr);
  }
  ctx.restore();
}

/**
 * One mark on every screen: one CSS pixel, and never under two device pixels,
 * so a Retina Mac stays a speck and an iPad still lands on a real sample.
 * A rotated streak at this size becomes a blob on some screens and nothing
 * on others, so the mark is a square snapped to the pixel grid.
 */
function paintGrain(ctx, dot, dpr) {
  const a = dot.q;
  const u = 1 / dpr;
  const px = Math.max(1, 2 / dpr);
  ctx.globalAlpha = dot.p.a * Math.min(1, 14 / dot.z);
  const x = Math.round(a.x / u) * u;
  const y = Math.round(a.y / u) * u;
  ctx.fillRect(x, y, px, px);
}


