/** Side view of the machine. Face-on sail is the thin plate. Edge-on sail faces the camera. */

import { stroke } from "./sim.js?v=106";

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

// Free-stream markers. The model’s wind is a uniform flow along +x, not a
// solved field, so these move at that speed and nothing else. While the sim
// is running they share its clock, including the rate button. While it is
// paused they keep drifting on the wall clock so the slider still shows.
const windParts = [];
const windDraw = [];
let windWall = 0;
let windSim = null;

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

function reseedWind(p, xLo, xHi, sailTop, atSail) {
  p.ox = 0;
  p.oy = 0;
  p.oz = 0;
  p.a = 0.35 + Math.random() * 0.4;
  p.x = xLo + Math.random() * Math.max(1, xHi - xLo);
  if (atSail) {
    p.y = 0.7 + Math.random() * Math.max(0.5, sailTop - 0.4);
    p.z = (Math.random() - 0.5) * 4.4;
  } else {
    p.y = 0.4 + Math.random() * (sailTop + 1.1);
    p.z = (Math.random() - 0.5) * 9;
  }
}

/**
 * Extra velocity so the free stream does not pass through the plate.
 * Face-on, air headed at the sail is pushed to the nearest edge and a
 * slower wake trails behind. Edge-on, the plate blocks nothing and the
 * extra velocity is zero. This is the same plate the force model uses,
 * drawn as a kinematic split, not a solved flow field.
 */
function sailWash(p, sail) {
  const c = Math.cos(sail.yaw);
  const s = Math.sin(sail.yaw);
  const dx = p.x - sail.bx;
  const lx = dx * c + p.z * s;
  const ly = p.y - sail.midY;
  const lz = -dx * s + p.z * c;
  const block = Math.abs(c);
  const U = sail.U;
  if (block < 0.04 || Math.abs(U) < 0.15) return [0, 0, 0];
  const reach = 1.15 * Math.max(sail.halfH, sail.halfW);
  const up = Math.sign(U * c) || 1;
  const upstream = -lx * up;
  const ny = Math.abs(ly) / sail.halfH;
  const nz = Math.abs(lz) / sail.halfW;
  const cover = Math.max(ny, nz);
  let vy = 0;
  let vzL = 0;
  let slow = 0;
  if (upstream > -0.2 && upstream < reach && cover < 1.4) {
    const near = Math.max(0, 1 - upstream / reach);
    const spill = Math.max(0, 1.2 - cover);
    const push = block * near * near * spill * Math.abs(U);
    const roomY = sail.halfH - Math.abs(ly);
    const roomZ = sail.halfW - Math.abs(lz);
    if (roomY < roomZ) vy = (ly < 0 ? -1 : 1) * push;
    else vzL = (lz < 0 ? -1 : 1) * push;
    slow = block * near * Math.max(0, 1 - cover) * Math.abs(U) * 0.75;
  }
  const down = -upstream;
  if (down > 0 && down < reach * 1.5 && cover < 1.05) {
    const fade = Math.max(0, 1 - down / (reach * 1.5));
    slow += block * fade * Math.abs(U) * 0.6;
    vy += (ly < 0 ? -1 : 1) * block * fade * Math.abs(U) * 0.18;
    vzL += (lz < 0 ? -1 : 1) * block * fade * Math.abs(U) * 0.18;
  }
  const flow = Math.sign(U) || 1;
  return [-slow * flow - vzL * s, vy, vzL * c];
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
    const sail = {
      bx,
      midY,
      yaw,
      halfH: s.plateH / 2,
      halfW: s.plateW / 2,
      U: speed - st.vx,
    };
    windDraw.length = 0;
    for (let i = 0; i < count; i++) {
      const p = windParts[i];
      const wash = sailWash(p, sail);
      p.ox += (wash[0] - (p.ox || 0)) * 0.55;
      p.oy += (wash[1] - (p.oy || 0)) * 0.55;
      p.oz += (wash[2] - (p.oz || 0)) * 0.55;
      p.x += (speed + p.ox) * dt;
      p.y += p.oy * dt;
      p.z += p.oz * dt;
      // A step can jump the thin plate. Put that air out at the nearest edge.
      if (Math.abs(Math.cos(yaw)) > 0.2) {
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const dx = p.x - bx;
        const lx = dx * c + p.z * sn;
        const ly = p.y - midY;
        const lz = -dx * sn + p.z * c;
        const hH = s.plateH / 2;
        const hW = s.plateW / 2;
        if (Math.abs(lx) < 0.25 && Math.abs(ly) < hH && Math.abs(lz) < hW) {
          const up = Math.sign(sail.U * c) || 1;
          let ly2 = ly;
          let lz2 = lz;
          if (hH - Math.abs(ly) < hW - Math.abs(lz)) ly2 = (ly < 0 ? -1 : 1) * (hH + 0.18);
          else lz2 = (lz < 0 ? -1 : 1) * (hW + 0.18);
          const lx2 = -0.06 * up;
          p.x = bx + lx2 * c - lz2 * sn;
          p.y = midY + ly2;
          p.z = lx2 * sn + lz2 * c;
        }
      }
      if (p.x > xHi || p.x < xLo || p.y > sailAir + 2.4 || p.y < 0.15) {
        reseedWind(p, xLo, xHi, sailAir, i % 2 === 0);
      }
      const q = project([p.x, p.y, p.z]);
      if (!q || q.z < 0.4) continue;
      const back = project([
        p.x - (speed + p.ox) * 0.01,
        p.y - p.oy * 0.01,
        p.z - p.oz * 0.01,
      ]);
      const minCss = 2 / dpr;
      const pxPerM = cam.fLen / Math.max(0.5, q.z);
      windDraw.push({
        p,
        q,
        back,
        z: q.z,
        along: Math.max(minCss, 0.015 * pxPerM),
        across: Math.max(minCss, 0.03 * pxPerM),
      });
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
 * A short streak along the wind. Size is a few centimetres of air, so a larger
 * screen shows a larger grain. Under about two device pixels a rotated streak
 * never lands on an iPad sample, so those draw as a square stamp instead.
 */
function paintGrain(ctx, dot, dpr) {
  const a = dot.q;
  const along = dot.along || 1;
  const across = dot.across || 1;
  ctx.globalAlpha = dot.p.a * Math.min(1, 22 / dot.z);
  const dpx = Math.max(along, across) * dpr;
  if (dpx < 2.5) {
    const s = Math.max(along, across, 2 / dpr);
    const u = 1 / dpr;
    const x = Math.round(a.x / u) * u;
    const y = Math.round(a.y / u) * u;
    ctx.fillRect(x, y, s, s);
    return;
  }
  const b = dot.back || a;
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const px = -dy;
  const py = dx;
  const al = along / 2;
  const ac = across / 2;
  ctx.beginPath();
  ctx.moveTo(a.x + dx * al + px * ac, a.y + dy * al + py * ac);
  ctx.lineTo(a.x + dx * al - px * ac, a.y + dy * al - py * ac);
  ctx.lineTo(a.x - dx * al - px * ac, a.y - dy * al - py * ac);
  ctx.lineTo(a.x - dx * al + px * ac, a.y - dy * al + py * ac);
  ctx.fill();
}


