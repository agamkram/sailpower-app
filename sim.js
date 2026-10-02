/** WindCart cycle. +x is downwind. Plate yaw 0 faces the wind, π/2 is edge-on. */

export function defaultSpecs() {
  return {
    wind: 10,
    track: 20,
    gauge: 1,
    plateW: 5,
    plateH: 2,
    mass: 24,
    sailRho: 1.6,
    cd: 1.28,
    rho: 1.225,
    thickness: 0.006,
    turn: 0.5,
    turnLead: 0.25,
    coilMode: "limited",
    fMax: 1000,
    etaG: 0.85,
    etaM: 0.85,
    crr: 0.005,
    vReturn: 8,
    outFrac: 1 / 3,
    cuMax: 120,
    eta: 0.85,
  };
}

/** Centre-of-pressure offset as a fraction of chord, for the slew torque. */
const SLEW_CP = 0.1;

/**
 * Everything that follows from the sail's shape rather than just its area.
 * Two sails of equal area behave differently: a wide one is far harder to yaw,
 * a slender one is a bluffer body, and a stubby one drags more air with it.
 *
 * cd       Hoerner's fit for a rectangular plate normal to the flow, with the
 *          Cd spec acting as a trim around the 1.28 reference.
 * inertia  yaw inertia about the vertical pivot, m*w^2/12. Scales with width
 *          squared, so this is what separates a 5x2 sail from a 2x5 one.
 * added    air entrained when the plate moves normal to itself. Conservative,
 *          so it shifts timing and peak force rather than net energy.
 */
export function rig(s) {
  const area = s.plateW * s.plateH;
  const span = Math.max(s.plateW, s.plateH);
  const chord = Math.min(s.plateW, s.plateH);
  const ar = Math.min(20, Math.max(1, chord > 0 ? span / chord : 1));
  const cd = Math.min(2, 1.1 + 0.02 * (ar + 1 / ar)) * (s.cd / 1.28);
  const sailMass = (s.sailRho ?? 1.6) * area;
  const inertia = (sailMass * s.plateW * s.plateW) / 12;
  const added = s.rho * (Math.PI / 4) * chord * chord * span * (1 - 0.42 / ar ** 0.8);
  return { area, ar, cd, sailMass, total: s.mass + sailMass, inertia, added };
}

/** Peak torque a real accelerate-then-decelerate slew would need, N m. */
export function slewTorque(s) {
  return (rig(s).inertia * 2 * Math.PI) / Math.max(0.15, s.turn) ** 2;
}

/**
 * A rotation plan is two numbers. `turn` is how long the 90° slew takes.
 * `turnLead` is how many seconds before the cart comes to rest the slew starts.
 * lead 0 turns only once stopped; lead === turn finishes exactly at rest;
 * lead > turn finishes while the cart is still moving.
 */
export const PRESETS = [
  { id: "stopped", name: "Turn once stopped", turnLead: 0 },
  { id: "arrive", name: "Finish as it stops", turnLead: 0.25 },
  { id: "slowing", name: "Turn while slowing", turnLead: 0.5 },
  { id: "early", name: "Turn before the brake", turnLead: 1 },
];

export function stroke(s) {
  const reach = 0.34;
  const cap = 0.08;
  const capHalf = 0.035;
  const gap = 0.45;
  const inset = cap + capHalf + reach + gap;
  return {
    lo: inset,
    hi: s.track - inset,
    cap0: cap,
    cap1: s.track - cap,
    half: reach,
  };
}

export function endPad(s) {
  return stroke(s).lo;
}

export function fitError(s) {
  const { lo, hi } = stroke(s);
  if (hi - lo < 2) return "Track is too short.";
  if (s.plateW < 0.2 || s.plateH < 0.2) return "Sail is too small.";
  return "";
}

export function createState(specs) {
  const s = { ...specs };
  if (s.eta != null) {
    s.etaG = s.eta;
    s.etaM = s.eta;
  }
  const { lo } = stroke(s);
  return {
    specs: s,
    x: lo,
    vx: 0,
    alpha: 0,
    phase: "out",
    time: 0,
    cycles: 0,
    gen: 0,
    mot: 0,
    hold: 0,
    slew: 0,
    slewing: false,
    inst: 0,
    force: 0,
    faero: 0,
    slip: false,
    lastCycleNet: 0,
    cycleGen: 0,
    cycleMot: 0,
    cycleHold: 0,
    cycleSlew: 0,
  };
}

export function netOf(st) {
  return st.gen - st.mot - st.hold - st.slew;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function limits(s) {
  const { lo, hi } = stroke(s);
  return { lo, hi };
}

/** Axial force on the cart, newtons, +x downwind. */
export function aeroForce(s, vx, alpha) {
  const vRel = vx - s.wind;
  const sp = Math.abs(vRel);
  const q = 0.5 * s.rho * sp * sp;
  const dir = vRel < 0 ? 1 : vRel > 0 ? -1 : 0;
  const r = rig(s);
  const c = Math.cos(alpha);
  const sn = Math.sin(alpha);
  const face = dir * q * r.cd * r.area * c * c;
  const edge = dir * q * 1.2 * (s.thickness * s.plateH) * sn * sn;
  const skin = dir * q * 0.008 * r.area;
  return face + edge + skin;
}

/** Moving mass including the slug of air the plate carries when face-on. */
function movingMass(s, alpha) {
  const r = rig(s);
  const c = Math.cos(alpha);
  return r.total + r.added * c * c;
}

function rollForce(s, vx) {
  if (Math.abs(vx) < 0.02) return 0;
  return -Math.sign(vx) * s.crr * rig(s).total * 9.81;
}

function brakeDist(s, speed, fa, mEff) {
  const push = speed >= 0 ? Math.max(0, fa) : Math.max(0, -fa);
  const net = s.fMax - push;
  if (net < 40) return Math.abs(speed) > 0.4 ? 1e6 : 0.15;
  const a = (net / Math.max(5, mEff)) * 0.85;
  return (speed * speed) / (2 * a) + 0.3;
}

function canHold(s, fa, fr) {
  return Math.abs(fa + fr) <= s.fMax;
}

/**
 * Seconds until the cart is at rest at the far cap: cruise the distance that is
 * left beyond the braking zone, then decelerate. Continuous across brake entry,
 * so a slew lead longer than the brake can reach back into the cruise.
 */
function timeToRest(remaining, speed, brake) {
  if (speed <= 0.05) return 0;
  const r = Math.max(0, remaining);
  return (r + Math.min(r, brake)) / speed;
}

function sub(st, dt) {
  const s = st.specs;
  const { lo, hi } = limits(s);
  const fa = aeroForce(s, st.vx, st.alpha);
  const fr = rollForce(s, st.vx);
  let phase = st.phase;
  const turnSec = Math.max(0.15, s.turn);
  const lead = Math.max(0, s.turnLead ?? 0);
  const vOut = s.wind * s.outFrac;
  const turnRate = (Math.PI / 2) / turnSec;
  const stiff = s.coilMode === "stiff";
  const rg = rig(s);
  const mEff = movingMass(s, st.alpha);
  const brake = brakeDist(s, st.vx, fa, mEff);
  const alpha0 = st.alpha;

  // Braking starts where the physics says it must: no recipe gets extra room.
  if (phase === "out" && st.vx >= 0 && hi - st.x <= brake) phase = "brakeOut";
  else if (phase === "back" && st.vx <= 0 && st.x - lo <= brake) phase = "brakeBack";

  if (phase === "out" || phase === "brakeOut") {
    if (timeToRest(hi - st.x, st.vx, brake) <= lead) {
      st.alpha = Math.min(Math.PI / 2, st.alpha + turnRate * dt);
    }
  } else if (phase === "back" || phase === "brakeBack") {
    if (timeToRest(st.x - lo, -st.vx, brake) <= lead) {
      st.alpha = Math.max(0, st.alpha - turnRate * dt);
    }
  } else if (phase === "turnEdge") {
    st.alpha = Math.min(Math.PI / 2, st.alpha + turnRate * dt);
  } else if (phase === "turnFace") {
    st.alpha = Math.max(0, st.alpha - turnRate * dt);
  }

  // Work the slew drive does: spin the sail up to rate, then recover on the
  // way down, plus the aero torque it turns against while the plate is loaded.
  const dAlpha = Math.abs(st.alpha - alpha0);
  const slewing = dAlpha > 1e-9;
  const spinKE = 0.5 * rg.inertia * turnRate * turnRate;
  let slewE = 0;
  if (slewing && !st.slewing) slewE += spinKE / s.etaM;
  else if (!slewing && st.slewing) slewE -= spinKE * s.etaG;
  if (slewing) {
    const vRel = st.vx - s.wind;
    const q = 0.5 * s.rho * vRel * vRel;
    const lever = SLEW_CP * s.plateW;
    const tAero =
      q * rg.cd * rg.area * lever * Math.abs(Math.sin(st.alpha) * Math.cos(st.alpha));
    slewE += (tAero * dAlpha) / s.etaM;
  }
  st.slewing = slewing;
  st.slew += slewE;
  st.cycleSlew += slewE;

  const faNow = aeroForce(s, st.vx, st.alpha);
  let fCmd;
  let coilLimited = false;
  if (stiff) {
    let raw;
    if (phase === "out") raw = mEff * 4 * (vOut - st.vx) - faNow - fr;
    else if (phase === "back") raw = mEff * 4 * (-Math.abs(s.vReturn) - st.vx) - faNow - fr;
    else if (phase === "brakeOut" || phase === "turnEdge") {
      raw = mEff * (22 * (hi - st.x) + 9 * (0 - st.vx)) - faNow - fr;
    } else {
      raw = mEff * (22 * (lo - st.x) + 9 * (0 - st.vx)) - faNow - fr;
    }
    coilLimited = Math.abs(raw) > s.fMax + 5;
    fCmd = clamp(raw, -s.fMax, s.fMax);
  } else {
    let aDes = 0;
    if (phase === "out") aDes = 4 * (vOut - st.vx);
    else if (phase === "back") aDes = 4 * (-Math.abs(s.vReturn) - st.vx);
    else if (phase === "brakeOut" || phase === "turnEdge") {
      const dist = Math.max(0.12, hi - st.x);
      aDes = st.vx > 0.05 ? -(st.vx * st.vx) / (2 * dist) : 4 * (0 - st.vx);
    } else {
      const dist = Math.max(0.12, st.x - lo);
      aDes = st.vx < -0.05 ? (st.vx * st.vx) / (2 * dist) : 4 * (0 - st.vx);
    }
    const aMin = (faNow + fr - s.fMax) / mEff;
    const aMax = (faNow + fr + s.fMax) / mEff;
    const aUse = clamp(aDes, aMin, aMax);
    coilLimited = Math.abs(aUse - aDes) > 0.2;
    fCmd = mEff * aUse - faNow - fr;
  }

  const ax = (faNow + fr + fCmd) / mEff;
  st.vx += ax * dt;
  st.x += st.vx * dt;
  if (st.x >= hi) {
    st.x = hi;
    if (st.vx > 0) st.vx = 0;
    if (phase === "out") phase = "brakeOut";
  } else if (st.x <= lo) {
    st.x = lo;
    if (st.vx < 0) st.vx = 0;
    if (phase === "back") phase = "brakeBack";
  }
  st.slip = false;
  if (coilLimited) {
    if (phase === "turnEdge" || phase === "turnFace") st.slip = Math.abs(st.vx) > 0.25;
    else if (phase === "brakeOut") st.slip = st.x > hi - 0.05 && st.vx > 0.4;
    else if (phase === "brakeBack") st.slip = st.x < lo + 0.05 && st.vx < -0.4;
    else if (phase === "out") st.slip = st.vx > vOut + 0.8;
    else if (phase === "back") st.slip = st.vx > 0.5;
  }

  const parked = Math.abs(st.vx) < 0.15;
  if ((phase === "brakeOut" || phase === "turnEdge") && parked && st.x > hi - 0.08) {
    st.vx = 0;
    st.x = hi;
    if (st.alpha >= Math.PI / 2 - 0.05) {
      st.alpha = Math.PI / 2;
      phase = "back";
    } else phase = "turnEdge";
  } else if ((phase === "brakeBack" || phase === "turnFace") && parked && st.x < lo + 0.08) {
    st.vx = 0;
    st.x = lo;
    if (st.alpha <= 0.05) {
      st.alpha = 0;
      phase = "out";
      st.cycles += 1;
      st.lastCycleNet = st.cycleGen - st.cycleMot - st.cycleHold - st.cycleSlew;
      st.cycleGen = 0;
      st.cycleMot = 0;
      st.cycleHold = 0;
      st.cycleSlew = 0;
    } else phase = "turnFace";
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
  inst -= slewE / dt;

  st.phase = phase;
  st.force = fCmd;
  st.faero = faNow;
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
      return "Feather";
    case "turnEdge":
      return "Edge-on";
    case "back":
      return "Return, edge-on";
    case "brakeBack":
      return "Opening";
    case "turnFace":
      return "Face-on";
    default:
      return phase;
  }
}
