/** Side view of the machine. Face-on sail is the thin plate. Edge-on sail faces the camera. */

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
function lerpP(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
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

export function draw(canvas, st) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
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

  const zCam = Math.max(3.425, s.plateW * 0.46 + 1.225);
  const eye = [followX, 1.735, zCam];
  const target = [followX, 0.26, 0];
  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const fov = 0.67;
  const fLen = h / 2 / Math.tan(fov / 2);
  const cam = { eye, xaxis, yaxis, zaxis, fLen, w, h };
  const NEAR = 0.16;

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
  function clipNear(pts) {
    const pack = pts.map((p) => ({ p, depth: depthOf(p) }));
    const out = [];
    for (let i = 0; i < pack.length; i++) {
      const a = pack[i];
      const b = pack[(i + 1) % pack.length];
      const aIn = a.depth >= NEAR;
      const bIn = b.depth >= NEAR;
      if (aIn && bIn) out.push(b.p);
      else if (aIn && !bIn) {
        const t = (a.depth - NEAR) / (a.depth - b.depth);
        out.push(lerpP(a.p, b.p, t));
      } else if (!aIn && bIn) {
        const t = (a.depth - NEAR) / (a.depth - b.depth);
        out.push(lerpP(a.p, b.p, t));
        out.push(b.p);
      }
    }
    return out;
  }
  function add(pts, color) {
    const clipped = clipNear(pts);
    if (clipped.length < 3) return;
    const proj = [];
    let z = 0;
    for (const p of clipped) {
      const q = project(p);
      if (!q) return;
      proj.push(q);
      z += q.z;
    }
    if (proj.some((q) => Math.abs(q.x) > w * 4 || Math.abs(q.y) > h * 4)) return;
    polys.push({ proj, color, z: z / proj.length });
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
  function wheel(c, axis, r, width, color, spin = 0, spokes = false) {
    const N = 10;
    const rings = [-width / 2, width / 2].map((off) => ring(c, axis, r, off, spin));
    add(rings[0], shade(color, 1.08));
    add(rings[1], shade(color, 0.72));
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      add([rings[0][i], rings[0][j], rings[1][j], rings[1][i]], shade(color, 0.9));
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
  function box(cx, cy, cz, sx, sy, sz, yaw, color) {
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
    faces.forEach((face, i) => add(face.map((k) => P[k]), shade(color, ks[i])));
  }

  const railR = 0.05;
  const railY = 0.2;
  const gauge = s.gauge;
  const x0 = followX - 2.6;
  const x1 = followX + 2.6;
  const bx = st.x;
  const spin = -st.x / 0.062;

  for (let gz = -1.4; gz < 1.5; gz += 0.28) {
    add(
      [
        [x0, 0, gz],
        [x1, 0, gz],
        [x1, 0, gz + 0.28],
        [x0, 0, gz + 0.28],
      ],
      0x10151c
    );
  }

  for (const z of [-gauge / 2, gauge / 2]) {
    const seg = 0.42;
    for (let x = x0; x < x1; x += seg) {
      const a0 = Math.max(0, x);
      const a1 = Math.min(s.track, x + seg);
      if (a1 - a0 < 0.05) continue;
      const mid = (a0 + a1) / 2;
      wheel([mid, railY, z], "x", railR, a1 - a0, RAIL, 0, false);
    }
  }

  for (let x = Math.floor(x0 * 2) / 2; x < x1; x += 0.38) {
    if (x < 0.05 || x > s.track - 0.05) continue;
    if (Math.abs(x - bx) < 0.5) continue;
    wheel([x, railY - 0.012, 0], "z", 0.02, gauge - railR * 2 - 0.02, RUNG, 0, false);
  }

  if (x0 < 0.08 && x1 > 0) box(0.04, railY + 0.08, 0, 0.04, 0.22, gauge + 0.08, 0, STOP);
  if (x0 < s.track && x1 > s.track - 0.08) {
    box(s.track - 0.04, railY + 0.08, 0, 0.04, 0.22, gauge + 0.08, 0, STOP);
  }

  const span0 = Math.max(0, x0);
  const span1 = Math.min(s.track, x1);
  if (span1 > span0) {
    const mid = (span0 + span1) / 2;
    const len = span1 - span0;
    box(mid, railY, 0, len, 0.032, 0.055, 0, 0xc5d2df);
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
  box(bx, (deckY + py0) / 2, 0, 0.045, py0 - deckY, 0.045, yaw, FRAME);
  box(bx, midY, 0, 0.018, s.plateH, s.plateW, yaw, PLATE);
  box(bx, py1 - 0.015, 0, 0.028, 0.03, s.plateW, yaw, PLATE_EDGE);
  box(bx, py0 + 0.015, 0, 0.028, 0.03, s.plateW, yaw, PLATE_EDGE);
  for (const end of [-1, 1]) {
    const [ox, oz] = yawXZ(0, end * (s.plateW / 2 - 0.015), yaw);
    box(bx + ox, midY, oz, 0.028, s.plateH, 0.03, yaw, PLATE_EDGE);
  }
  const [rx, rz] = yawXZ(0, 0.22, yaw);
  box(bx + rx, py0 + s.plateH * 0.28, rz, 0.02, s.plateH * 0.5, 0.025, yaw, PLATE_EDGE);

  polys.sort((a, b) => b.z - a.z);
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(poly.proj[0].x, poly.proj[0].y);
    for (let i = 1; i < poly.proj.length; i++) ctx.lineTo(poly.proj[i].x, poly.proj[i].y);
    ctx.closePath();
    ctx.fillStyle = hex(poly.color);
    ctx.fill();
  }

  ctx.fillStyle = "rgba(232,237,244,0.78)";
  ctx.font = "600 12px 'DM Sans', system-ui, sans-serif";
  ctx.fillText("wind", 14, 22);
  ctx.beginPath();
  ctx.moveTo(58, 18);
  ctx.lineTo(96, 18);
  ctx.lineTo(90, 13);
  ctx.moveTo(96, 18);
  ctx.lineTo(90, 23);
  ctx.strokeStyle = "rgba(232,237,244,0.78)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
