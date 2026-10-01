/** Side view. Face-on plate is the thin one. Edge-on plate faces the camera. */

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
  return `rgb(${r},${g},${b})`;
}
function shade(n, k) {
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) * k));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) * k));
  const b = Math.max(0, Math.min(255, (n & 255) * k));
  return (r << 16) | (g << 8) | b;
}

const RAIL = 0xb4232a;
const FRAME = 0x8e99a6;
const WHEEL = 0xd5dbe3;
const TIRE = 0x2a3140;
const PLATE = 0x8b939c;
const SKATE = 0xc5d0dc;
const SKATE_ON = 0xe2b340;
const SKATE_MOT = 0x6eb6e0;
const RUNG = 0x8e1a22;

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
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#141b26");
  g.addColorStop(0.55, "#0c1118");
  g.addColorStop(1, "#080b10");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const s = st.specs;
  // Square to the track: face-on reads as a thin plate, edge-on as the broad face.
  const eye = [st.x, 1.05, 4.15];
  const target = [st.x, 0.48, 0];
  const zaxis = norm(sub(eye, target));
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const fov = 0.86;
  const f = h / 2 / Math.tan(fov / 2);
  const cam = { eye, xaxis, yaxis, zaxis, f, w, h };

  const polys = [];
  function project(p) {
    const d = sub(p, cam.eye);
    const depth = -dot(d, cam.zaxis);
    if (depth < 0.08) return null;
    return {
      x: w / 2 + (dot(d, cam.xaxis) / depth) * cam.f,
      y: h / 2 - (dot(d, cam.yaxis) / depth) * cam.f,
      z: depth,
    };
  }
  function add(pts, color) {
    const proj = [];
    let z = 0;
    for (const p of pts) {
      const q = project(p);
      if (!q) return;
      proj.push(q);
      z += q.z;
    }
    polys.push({ proj, color, z: z / pts.length });
  }
  function wheel(c, axis, r, width, color) {
    const N = 12;
    const rings = [-width / 2, width / 2].map((off) => {
      const pts = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const cs = Math.cos(a) * r;
        const sn = Math.sin(a) * r;
        if (axis === "z") pts.push([c[0] + cs, c[1] + sn, c[2] + off]);
        else if (axis === "y") pts.push([c[0] + cs, c[1] + off, c[2] + sn]);
        else pts.push([c[0] + off, c[1] + cs, c[2] + sn]);
      }
      return pts;
    });
    add(rings[0], shade(color, 1.05));
    add(rings[1], shade(color, 0.78));
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      add([rings[0][i], rings[0][j], rings[1][j], rings[1][i]], shade(color, 0.9));
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
    // corners: x0y0z0, x0y0z1, x0y1z0, x0y1z1, x1y0z0, x1y0z1, x1y1z0, x1y1z1
    const faces = [
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
      [0, 2, 3, 1],
      [4, 5, 7, 6],
    ];
    const ks = [0.7, 1.05, 0.85, 0.95, 0.6, 0.9];
    faces.forEach((f, i) => add(f.map((k) => P[k]), shade(color, ks[i])));
  }

  const railR = 0.06;
  const railY = 0.2;
  const gauge = s.gauge;
  const x0 = st.x - 9;
  const x1 = st.x + 7;

  add(
    [
      [x0, 0, -2.2],
      [x1, 0, -2.2],
      [x1, 0, 2.2],
      [x0, 0, 2.2],
    ],
    0x10151c
  );

  for (let x = Math.floor(x0); x < x1; x += 0.55) {
    if (x < -0.2 || x > s.track + 0.2) continue;
    box(x, railY, 0, 0.06, 0.045, gauge - 0.12, 0, RUNG);
  }

  for (const z of [-gauge / 2, gauge / 2]) {
    const seg = 0.7;
    for (let x = x0; x < x1; x += seg) {
      if (x + seg < -0.3 || x > s.track + 0.3) continue;
      const a0 = Math.max(-0.15, x);
      const a1 = Math.min(s.track + 0.15, x + seg);
      if (a1 <= a0) continue;
      wheel([(a0 + a1) / 2, railY, z], "x", railR, a1 - a0, RAIL);
    }
  }

  const span0 = Math.max(0, st.x - 5);
  const span1 = Math.min(s.track, st.x + 5);
  if (span1 > span0) {
    box((span0 + span1) / 2, railY - 0.02, 0, span1 - span0, 0.035, 0.08, 0, 0x3a4454);
  }

  const bx = st.x;
  const topR = 0.07;
  const sideR = 0.04;
  const botR = 0.05;
  for (const z of [-gauge / 2, gauge / 2]) {
    const side = Math.sign(z) || 1;
    for (const dx of [-0.26, 0.26]) {
      wheel([bx + dx, railY + railR + topR * 0.92, z], "z", topR, 0.038, WHEEL);
      wheel([bx + dx, railY + railR + topR * 0.92, z], "z", 0.018, 0.04, TIRE);
    }
    for (const dx of [-0.08, 0.08]) {
      wheel(
        [bx + dx, railY, z + side * (railR + sideR * 0.85)],
        "y",
        sideR,
        0.028,
        WHEEL
      );
    }
    for (const dx of [-0.16, 0.16]) {
      wheel([bx + dx, railY - railR - botR * 0.85, z], "z", botR, 0.032, FRAME);
    }
    box(bx, railY + railR + topR * 1.55, z, 0.72, 0.05, 0.07, 0, FRAME);
  }
  box(bx, railY + railR + topR * 1.7, 0, 0.16, 0.06, gauge - 0.05, 0, FRAME);
  box(bx, railY + 0.02, 0, 0.22, 0.08, 0.16, 0, 0x6d7886);

  const generating = st.inst > 30;
  const motoring = st.inst < -30;
  const skateColor = generating ? SKATE_ON : motoring ? SKATE_MOT : SKATE;
  box(bx, railY + 0.01, 0, 0.36, 0.05, 0.1, 0, skateColor);

  const py0 = railY + 0.42;
  const py1 = py0 + s.plateH;
  const yaw = st.alpha;
  box(bx, (py0 + py1) / 2, 0, 0.02, s.plateH, s.plateW, yaw, PLATE);
  box(bx, py0 - 0.08, 0, 0.06, 0.16, 0.06, 0, FRAME);

  polys.sort((a, b) => b.z - a.z);
  for (const poly of polys) {
    ctx.beginPath();
    ctx.moveTo(poly.proj[0].x, poly.proj[0].y);
    for (let i = 1; i < poly.proj.length; i++) ctx.lineTo(poly.proj[i].x, poly.proj[i].y);
    ctx.closePath();
    ctx.fillStyle = hex(poly.color);
    ctx.fill();
  }

  ctx.fillStyle = "rgba(232,237,244,0.72)";
  ctx.font = "600 12px 'DM Sans', system-ui, sans-serif";
  ctx.fillText("wind", 14, 22);
  ctx.beginPath();
  ctx.moveTo(58, 18);
  ctx.lineTo(96, 18);
  ctx.lineTo(90, 13);
  ctx.moveTo(96, 18);
  ctx.lineTo(90, 23);
  ctx.strokeStyle = "rgba(232,237,244,0.72)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
