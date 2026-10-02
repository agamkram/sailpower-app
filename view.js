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
  const dpr = Math.min(1.25, window.devicePixelRatio || 1);
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

  const zCam = 7.78;
  const eye = [followX - 1.35, 3.36, zCam];
  const target = [followX + 0.35, 0.81, 0];
  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const fov = 0.98;
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
    let zMin = Infinity;
    for (const p of clipped) {
      const q = project(p);
      if (!q) return;
      if (q.z < 0.45) return;
      proj.push(q);
      z += q.z;
      if (q.z < zMin) zMin = q.z;
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const q of proj) {
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    if (x1 - x0 > w * 1.8 || y1 - y0 > h * 1.8) return;
    if (Math.abs(x0) > w * 2 || Math.abs(x1) > w * 2) return;
    if (Math.abs(y0) > h * 2 || Math.abs(y1) > h * 2) return;
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
  const x0 = followX - 2.1;
  const x1 = followX + 2.1;
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
    const seg = 0.55;
    for (let x = x0; x < x1; x += seg) {
      const a0 = Math.max(0, x);
      const a1 = Math.min(s.track, x + seg);
      if (a1 - a0 < 0.05) continue;
      box((a0 + a1) / 2, railY, z, a1 - a0 + 0.012, railR * 1.7, railR * 1.7, 0, RAIL);
    }
  }

  for (let x = Math.floor(x0 * 2) / 2; x < x1; x += 0.38) {
    if (x < 0.05 || x > s.track - 0.05) continue;
    if (Math.abs(x - bx) < 0.5) continue;
    box(x, railY - 0.01, 0, 0.03, 0.028, gauge - railR * 2.2, 0, RUNG);
  }

  if (x0 < 0.08 && x1 > 0) box(0.04, railY + 0.08, 0, 0.04, 0.22, gauge + 0.08, 0, STOP);
  if (x0 < s.track && x1 > s.track - 0.08) {
    box(s.track - 0.04, railY + 0.08, 0, 0.04, 0.22, gauge + 0.08, 0, STOP);
  }

  const span0 = Math.max(0, x0);
  const span1 = Math.min(s.track, x1);
  if (span1 > span0) {
    const seg = 0.55;
    for (let x = span0; x < span1; x += seg) {
      const a0 = x;
      const a1 = Math.min(span1, x + seg);
      if (a1 - a0 < 0.05) continue;
      box((a0 + a1) / 2, railY, 0, a1 - a0 + 0.04, 0.032, 0.055, 0, 0xc5d2df);
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
  box(bx, (deckY + py0) / 2, 0, 0.045, py0 - deckY, 0.045, yaw, FRAME);
  {
    const hx = 0.011;
    const hy = s.plateH / 2;
    const hz = s.plateW / 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const corner = (x, y, z) => [bx + x * c - z * sn, midY + y, x * sn + z * c];
    const strips = 8;
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
    const rim = Math.max(0.16, s.plateW * 0.04);
    box(bx, py1 - 0.01, 0, 0.03, 0.02, s.plateW - rim, yaw, PLATE_EDGE);
    box(bx, py0 + 0.01, 0, 0.03, 0.02, s.plateW - rim, yaw, PLATE_EDGE);
  }

  polys.sort((a, b) => b.z - a.z);
  const iw = canvas.width;
  const ih = canvas.height;
  const depth = new Float32Array(Math.max(1, iw * ih));
  depth.fill(1e9);
  const img = ctx.createImageData(iw, ih);
  const data = img.data;
  // Rebuild the sky in device pixels — putImageData ignores the CSS transform.
  for (let y = 0; y < ih; y++) {
    const t = y / Math.max(1, ih - 1);
    let r;
    let g;
    let b;
    if (t < 0.45) {
      const u = t / 0.45;
      r = (0x16 + (0x0d - 0x16) * u) | 0;
      g = (0x1d + (0x12 - 0x1d) * u) | 0;
      b = (0x28 + (0x19 - 0x28) * u) | 0;
    } else {
      const u = (t - 0.45) / 0.55;
      r = (0x0d + (0x07 - 0x0d) * u) | 0;
      g = (0x12 + (0x0a - 0x12) * u) | 0;
      b = (0x19 + (0x0e - 0x19) * u) | 0;
    }
    for (let x = 0; x < iw; x++) {
      const o = (y * iw + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  function putTri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    ax *= dpr;
    ay *= dpr;
    bx *= dpr;
    by *= dpr;
    cx *= dpr;
    cy *= dpr;
    let minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    let maxX = Math.min(iw - 1, Math.ceil(Math.max(ax, bx, cx)));
    let minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    let maxY = Math.min(ih - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) return;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) return;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const wA = ((bx - x) * (cy - y) - (by - y) * (cx - x)) * inv;
        const wB = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) * inv;
        const wC = 1 - wA - wB;
        if (wA < -0.001 || wB < -0.001 || wC < -0.001) continue;
        const z = wA * az + wB * bz + wC * cz;
        const di = y * iw + x;
        if (z >= depth[di]) continue;
        depth[di] = z;
        const o = di * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
  }

  for (const poly of polys) {
    const col = poly.color;
    const r = (col >> 16) & 255;
    const g = (col >> 8) & 255;
    const b = col & 255;
    const p0 = poly.proj[0];
    for (let i = 1; i < poly.proj.length - 1; i++) {
      const p1 = poly.proj[i];
      const p2 = poly.proj[i + 1];
      putTri(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, r, g, b);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(img, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
