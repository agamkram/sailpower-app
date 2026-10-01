/** WindCart cycle. +x is downwind. Plate yaw 0 faces the wind, π/2 is edge-on. */

export function defaultSpecs() {
  return {
    wind: 10,
    track: 20,
    gauge: 1,
    plateW: 5,
    plateH: 2,
    mass: 40,
    cd: 1.28,
    rho: 1.225,
    thickness: 0.006,
    turn: 1,
    fMax: 1000,
    etaG: 0.85,
    etaM: 0.85,
    crr: 0.005,
    vReturn: 8,
    outFrac: 1 / 3,
    cuMax: 120,
  };
}

export function endPad(s) {
  return 0.5 * s.plateW + 0.5;
}

export function fitError(s) {
  if (endPad(s) * 2 + 2 > s.track) return "Plate is too wide for this track.";
  if (s.plateW < 0.2 || s.plateH < 0.2) return "Plate is too small.";
  return "";
}

export function createState(specs) {
  const s = { ...specs };
  const pad = endPad(s);
  return {
    specs: s,
    x: pad,
    vx: 0,
    alpha: 0,
    phase: "out",
    time: 0,
    cycles: 0,
    gen: 0,
    mot: 0,
    hold: 0,
    inst: 0,
    force: 0,
    faero: 0,
    lastCycleNet: 0,
    cycleGen: 0,
    cycleMot: 0,
    cycleHold: 0,
  };
}

export function netOf(st) {
  return st.gen - st.mot - st.hold;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function limits(s) {
  const pad = endPad(s);
  return { lo: pad, hi: s.track - pad };
}

/** Axial force on the cart, newtons, +x downwind. */
export function aeroForce(s, vx, alpha) {
  const vRel = vx - s.wind;
  const sp = Math.abs(vRel);
  const q = 0.5 * s.rho * sp * sp;
  const dir = vRel < 0 ? 1 : vRel > 0 ? -1 : 0;
  const area = s.plateW * s.plateH;
  const c = Math.cos(alpha);
  const sn = Math.sin(alpha);
  const face = dir * q * s.cd * area * c * c;
  const edge = dir * q * 1.2 * (s.thickness * s.plateH) * sn * sn;
  const skin = dir * q * 0.008 * area;
  return face + edge + skin;
}

function rollForce(s, vx) {
  if (Math.abs(vx) < 0.02) return 0;
  return -Math.sign(vx) * s.crr * s.mass * 9.81;
}

function brakeDist(s, speed) {
  const a = (s.fMax / Math.max(5, s.mass)) * 0.8;
  return (speed * speed) / (2 * Math.max(0.5, a)) + 0.3;
}

function sub(st, dt) {
  const s = st.specs;
  const { lo, hi } = limits(s);
  const fa = aeroForce(s, st.vx, st.alpha);
  const fr = rollForce(s, st.vx);
  let phase = st.phase;
  const vOut = s.wind * s.outFrac;

  if (phase === "out" && st.vx >= 0 && hi - st.x <= brakeDist(s, Math.max(st.vx, 0.4))) {
    phase = "brakeOut";
  } else if (phase === "back" && st.vx <= 0 && st.x - lo <= brakeDist(s, Math.max(-st.vx, 0.4))) {
    phase = "brakeBack";
  }

  let vTarget = 0;
  let xTarget = st.x;
  if (phase === "out") vTarget = vOut;
  else if (phase === "back") vTarget = -Math.abs(s.vReturn);
  else if (phase === "brakeOut" || phase === "turnEdge") xTarget = hi;
  else xTarget = lo;

  let fCmd;
  if (phase === "out" || phase === "back") {
    fCmd = s.mass * 4 * (vTarget - st.vx) - fa - fr;
  } else {
    fCmd = s.mass * (22 * (xTarget - st.x) + 9 * (0 - st.vx)) - fa - fr;
  }
  fCmd = clamp(fCmd, -s.fMax, s.fMax);

  const ax = (fa + fr + fCmd) / s.mass;
  st.vx += ax * dt;
  st.x += st.vx * dt;

  if (phase === "brakeOut" && Math.abs(st.vx) < 0.08 && Math.abs(st.x - hi) < 0.35) {
    st.vx = 0;
    st.x = hi;
    phase = "turnEdge";
  } else if (phase === "brakeBack" && Math.abs(st.vx) < 0.08 && Math.abs(st.x - lo) < 0.35) {
    st.vx = 0;
    st.x = lo;
    phase = "turnFace";
  }

  const turnRate = (Math.PI / 2) / Math.max(0.15, s.turn);
  if (phase === "turnEdge") {
    st.alpha = Math.min(Math.PI / 2, st.alpha + turnRate * dt);
    st.vx = 0;
    st.x = hi;
    if (st.alpha >= Math.PI / 2 - 1e-4) {
      st.alpha = Math.PI / 2;
      phase = "back";
    }
  } else if (phase === "turnFace") {
    st.alpha = Math.max(0, st.alpha - turnRate * dt);
    st.vx = 0;
    st.x = lo;
    if (st.alpha <= 1e-4) {
      st.alpha = 0;
      phase = "out";
      st.cycles += 1;
      st.lastCycleNet = st.cycleGen - st.cycleMot - st.cycleHold;
      st.cycleGen = 0;
      st.cycleMot = 0;
      st.cycleHold = 0;
    }
  }

  const mech = -fCmd * st.vx;
  let inst = 0;
  if (mech >= 0) {
    const e = mech * s.etaG * dt;
    st.gen += e;
    st.cycleGen += e;
    inst = mech * s.etaG;
  } else {
    const e = (-mech / s.etaM) * dt;
    st.mot += e;
    st.cycleMot += e;
    inst = mech / s.etaM;
  }
  if (Math.abs(st.vx) < 0.08) {
    const cu = s.cuMax * (fCmd / s.fMax) ** 2;
    const e = cu * dt;
    st.hold += e;
    st.cycleHold += e;
    inst -= cu;
  }

  st.phase = phase;
  st.force = fCmd;
  st.faero = fa;
  st.inst = inst;
  st.time += dt;
}

export function step(st, dt) {
  const h = 1 / 200;
  let left = Math.max(0, dt);
  while (left > 1e-8) {
    const d = Math.min(h, left);
    sub(st, d);
    left -= d;
  }
}

export function phaseLabel(phase) {
  switch (phase) {
    case "out":
      return "Out, face-on";
    case "brakeOut":
      return "Brake";
    case "turnEdge":
      return "Turn edge-on";
    case "back":
      return "Return, edge-on";
    case "brakeBack":
      return "Brake";
    case "turnFace":
      return "Turn face-on";
    default:
      return phase;
  }
}
