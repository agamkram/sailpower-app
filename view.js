/** Side view of the machine. Face-on sail is the thin plate. Edge-on sail faces the camera. */

import { stroke } from "./sim.js?v=78";

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
const PLATE = 0x8d959e;
const PLATE_EDGE = 0x5a636c;
const MOTOR = 0x3e4a5c;
const MOTOR_CAP = 0x1a212b;
const RING = 0xb7c0ca;
const STEEL = 0x3c4654;
const TOOTH = 0x6a7686;
const SKATE_ON = 0xe2b340;
const SKATE_MOT = 0x6eb6e0;
const STOP = 0x6e1218;

let followX = null;

const CAM0 = {
  yaw: Math.atan2(-1.7, 7.78),
  pitch: Math.asin(2.55 / Math.hypot(1.7, 2.55, 7.78)),
  dist: Math.hypot(1.7, 2.55, 7.78),
};
const camCtl = { yaw: CAM0.yaw, pitch: CAM0.pitch, dist: CAM0.dist };

export function resetCam() {
  camCtl.yaw = CAM0.yaw;
  camCtl.pitch = CAM0.pitch;
  camCtl.dist = CAM0.dist;
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
    camCtl.dist = Math.max(3.2, Math.min(18, camCtl.dist));
  }
  function fire() {
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
          fire();
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

  const target = [followX + 0.35, 1.35, 0];
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
  const fov = 0.98;
  const fLen = h / 2 / Math.tan(fov / 2);
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
  function ring(c, axis, r, off, spin) {
    const N = 10;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + spin;
      const cs = Math.cos(a) * r;
      const sn = Math.sin(a) * r;
      if (axis === "z") pts.push([c[0] + cs, c[1] + sn, c[2] + off]);
      else if (axis === "y") pts.push([c[0] + cs, c[1] + off, c[2] + sn]);
      else pts.push([c[0] + off, c[1] + cs, c[2] + sn]);
    }
    return pts;
  }
  function wheel(c, axis, r, width, color, spin = 0, spokes = false, open = false, layer = 0) {
    const N = 10;
    const rings = [-width / 2, width / 2].map((off) => ring(c, axis, r, off, spin));
    if (!open) {
      add(rings[0], shade(color, 1.08), layer);
      add(rings[1], shade(color, 0.72), layer);
    }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      add([rings[0][i], rings[0][j], rings[1][j], rings[1][i]], shade(color, 0.9), layer);
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
  const { lo, hi, cap0, cap1 } = stroke(s);
  let x0 = followX - 4.2;
  let x1 = followX + 4.2;
  if (followX < lo + 2.2) x0 = cap0 - 0.2;
  if (followX > hi - 2.2) x1 = cap1 + 0.2;
  x0 = Math.max(cap0 - 0.2, x0);
  x1 = Math.min(cap1 + 0.2, x1);
  const bx = st.x;
  const spin = -st.x / 0.062;

  {
    const foot = project([bx, 0.02, 0]);
    if (foot) {
      const rx = Math.max(48, 2200 / Math.max(2.5, foot.z));
      const ry = rx * 0.28;
      const g = ctx.createRadialGradient(foot.x, foot.y, rx * 0.08, foot.x, foot.y, rx);
      g.addColorStop(0, "rgba(0, 0, 0, 0.38)");
      g.addColorStop(0.55, "rgba(0, 0, 0, 0.14)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const z of [-gauge / 2, gauge / 2]) {
    const seg = 0.48;
    for (let x = x0; x < x1; x += seg) {
      const a0 = Math.max(cap0, x);
      const a1 = Math.min(cap1, x + seg + 0.06);
      if (a1 - a0 < 0.05) continue;
      wheel([(a0 + a1) / 2, railY, z], "x", railR, a1 - a0, RAIL, 0, false, true, 2);
    }
  }

  for (let x = Math.floor(x0 * 2) / 2; x < x1; x += 0.4) {
    if (x < cap0 + 0.05 || x > cap1 - 0.05) continue;
    if (Math.abs(x - bx) < 0.36) continue;
    wheel([x, railY - 0.012, 0], "z", 0.02, gauge - railR * 2 - 0.02, RUNG, 0, false, true, 2);
  }

  if (x0 < cap0 + 0.45) box(cap0, railY + 0.1, 0, 0.07, 0.32, gauge + 0.16, 0, STOP);
  if (x1 > cap1 - 0.45) box(cap1, railY + 0.1, 0, 0.07, 0.32, gauge + 0.16, 0, STOP);

  const span0 = Math.max(cap0, x0);
  const span1 = Math.min(cap1, x1);
  if (span1 > span0) {
    const seg = 0.48;
    for (let x = span0; x < span1; x += seg) {
      const a0 = x;
      const a1 = Math.min(span1, x + seg + 0.06);
      if (a1 - a0 < 0.05) continue;
      wheel([(a0 + a1) / 2, railY, 0], "x", 0.026, a1 - a0, 0xc5d2df, 0, false, true, 2);
    }
  }

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
  for (let i = -2; i <= 2; i++) {
    box(bx + i * 0.07, railY - 0.012, 0, 0.05, 0.022, 0.06, 0, i % 2 ? mag : shade(mag, 0.55));
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
  // Sail as Z-strips so a near edge can't depth-sort over the whole track.
  {
    const hx = 0.012;
    const hy = s.plateH / 2;
    const hz = s.plateW / 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const corner = (x, y, z) => [bx + x * c - z * sn, midY + y, x * sn + z * c];
    const strips = 10;
    for (let i = 0; i < strips; i++) {
      const z0 = -hz + (i / strips) * s.plateW;
      const z1 = -hz + ((i + 1) / strips) * s.plateW;
      add(
        [corner(hx, -hy, z0), corner(hx, -hy, z1), corner(hx, hy, z1), corner(hx, hy, z0)],
        shade(PLATE, 1.05)
      );
      add(
        [corner(-hx, -hy, z0), corner(-hx, hy, z0), corner(-hx, hy, z1), corner(-hx, -hy, z1)],
        shade(PLATE, 0.72)
      );
    }
    // Stand the edge rails proud of the skin. Matching its thickness made them
    // z-fight, so they only resolved on whichever face won the sort.
    box(bx, py1 - 0.018, 0, 0.056, 0.036, s.plateW, yaw, PLATE_EDGE);
    box(bx, py0 + 0.018, 0, 0.056, 0.036, s.plateW, yaw, PLATE_EDGE);
  }

  polys.sort((a, b) => b.z - a.z || b.layer - a.layer);
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(poly.proj[0].x, poly.proj[0].y);
    for (let i = 1; i < poly.proj.length; i++) ctx.lineTo(poly.proj[i].x, poly.proj[i].y);
    ctx.closePath();
    ctx.fillStyle = hex(poly.color);
    ctx.fill();
  }

  windArrow(ctx, cam);
}

/**
 * The wind blows along world +x, so the badge has to turn with the camera.
 * When it points nearly at or away from the viewer there is no direction left
 * to draw, and the conventional dot-in-circle or cross-in-circle says it.
 */
function windArrow(ctx, cam) {
  const ink = "rgba(232,237,244,0.78)";
  const dir = [1, 0, 0];
  const sx = dot(dir, cam.xaxis);
  const sy = -dot(dir, cam.yaxis);
  const toward = -dot(dir, cam.zaxis);
  const flat = Math.hypot(sx, sy);

  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.font = "600 12px 'DM Sans', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("wind", 14, 20);

  ctx.translate(78, 20);
  if (flat < 0.18) {
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    if (toward > 0) {
      ctx.moveTo(-4, -4);
      ctx.lineTo(4, 4);
      ctx.moveTo(4, -4);
      ctx.lineTo(-4, 4);
      ctx.stroke();
    } else {
      ctx.arc(0, 0, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const half = 19 * flat;
    ctx.rotate(Math.atan2(sy, sx));
    ctx.beginPath();
    ctx.moveTo(-half, 0);
    ctx.lineTo(half, 0);
    ctx.moveTo(half, 0);
    ctx.lineTo(half - 5, -4);
    ctx.moveTo(half, 0);
    ctx.lineTo(half - 5, 4);
    ctx.stroke();
  }
  ctx.restore();
}
