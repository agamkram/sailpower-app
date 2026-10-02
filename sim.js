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
    turn: 0.7,
    turnLead: 0.3,
    coilMode: "limited",
    fMax: 1000,
    etaG: 0.95,
    etaM: 0.95,
    vNoLoad: 22,
    ironRef: 35,
    slewRegen: 0,
    crr: 0.005,
    vReturn: 8,
    outFrac: 0.24,
    cuMax: 120,
    eta: 0.95,
  };
}

/**
 * What the coils can actually deliver at this speed.
 *
 * Motoring has to push current against back-EMF, so the available force falls
 * away as the cart speeds up and reaches zero at vNoLoad. Braking is the other
 * way round: the motion generates the voltage, so the only ceiling is thermal.
 */
export function forceLimit(s, vx, motoring) {
  if (!motoring) return s.fMax;
  const vnl = Math.max(1, s.vNoLoad ?? 22);
  return s.fMax * Math.max(0, 1 - Math.abs(vx) / vnl);
}

/**
 * Smallest yaw that keeps the sail's push inside the coils' authority. Above
 * roughly 12 m/s of wind a 10 m2 sail out-pushes the rail, and a real machine
 * sheds the excess by turning away from the wind rather than stalling.
 */
export function featherFloor(s, vx) {
  const vRel = vx - s.wind;
  const q = 0.5 * s.rho * vRel * vRel;
  const r = rig(s);
  const full = q * r.cd * r.area;
  const cap = forceLimit(s, vx, false) * 0.9;
  if (full <= cap || full <= 0) return 0;
  return Math.acos(Math.sqrt(clamp(cap / full, 0, 1)));
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
  { id: "stopped", name: "Once stopped", turnLead: 0 },
  { id: "arrive", name: "As it stops", turnLead: 0.3 },
  { id: "slowing", name: "While slowing", turnLead: 0.6 },
  { id: "early", name: "Before the brake", turnLead: 1 },
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
    slew: 0,
    slewing: false,
    loss: 0,
    stop: 0,
    inst: 0,
    force: 0,
    faero: 0,
    slip: false,
    feather: 0,
    saturated: false,
    satTime: 0,
    cycleT: 0,
    lastCycleS: 0,
    lastCycleNet: 0,
    cycleGen: 0,
    cycleMot: 0,
    cycleSlew: 0,
    cycleLoss: 0,
    cycleStop: 0,
  };
}

export function netOf(st) {
  return st.gen - st.mot - st.slew - st.loss - st.stop;
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

/**
 * Wheels carry the weight and also react the sail's thrust through the guide
 * rollers, and at 10 m/s that thrust is about twice the weight.
 */
function rollForce(s, vx, fa) {
  if (Math.abs(vx) < 0.02) return 0;
  const normal = rig(s).total * 9.81 + Math.abs(fa);
  return -Math.sign(vx) * s.crr * normal;
}

function brakeDist(s, speed, fa, mEff) {
  const push = speed >= 0 ? Math.max(0, fa) : Math.max(0, -fa);
  const net = forceLimit(s, speed, false) - push;
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
  const fr = rollForce(s, st.vx, fa);
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

  // Shed load rather than stall. The sail can never come further into the wind
  // than the rail can hold against, so in a gale it simply runs part-feathered.
  // Only call it feathered when the floor is actually holding the sail off the
  // wind. On the fast return the apparent wind makes the floor non-zero even
  // though the sail is already edge-on and nothing is being given up.
  const floor = featherFloor(s, st.vx);
  const bound = st.alpha < floor;
  st.feather = bound ? floor : 0;
  if (bound) st.alpha = Math.min(Math.PI / 2, floor);

  // Work the slew drive does: spin the sail up to rate, then recover on the
  // way down, plus the aero torque it turns against while the plate is loaded.
  const dAlpha = Math.abs(st.alpha - alpha0);
  const slewing = dAlpha > 1e-9;
  const spinKE = 0.5 * rg.inertia * turnRate * turnRate;
  let slewE = 0;
  // A geared slew drive is not back-drivable, so by default the spin-down goes
  // into the brake rather than back onto the bus. slewRegen buys that back.
  if (slewing && !st.slewing) slewE += spinKE / s.etaM;
  else if (!slewing && st.slewing) slewE -= spinKE * s.etaG * (s.slewRegen ?? 0);
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
    const up = st.vx >= 0 ? forceLimit(s, st.vx, true) : forceLimit(s, st.vx, false);
    const dn = st.vx >= 0 ? forceLimit(s, st.vx, false) : forceLimit(s, st.vx, true);
    coilLimited = raw > up + 5 || raw < -dn - 5;
    fCmd = clamp(raw, -dn, up);
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
    const up = st.vx >= 0 ? forceLimit(s, st.vx, true) : forceLimit(s, st.vx, false);
    const dn = st.vx >= 0 ? forceLimit(s, st.vx, false) : forceLimit(s, st.vx, true);
    const aMin = (faNow + fr - dn) / mEff;
    const aMax = (faNow + fr + up) / mEff;
    const aUse = clamp(aDes, aMin, aMax);
    coilLimited = Math.abs(aUse - aDes) > 0.2;
    fCmd = mEff * aUse - faNow - fr;
  }
  st.saturated = coilLimited;
  if (coilLimited) st.satTime += dt;

  const ax = (faNow + fr + fCmd) / mEff;
  st.vx += ax * dt;
  st.x += st.vx * dt;
  if (st.x >= hi) {
    st.x = hi;
    if (st.vx > 0) {
      // Hitting the stop is a loss, not a free brake. Charge what it absorbs.
      const e = 0.5 * mEff * st.vx * st.vx;
      st.stop += e;
      st.cycleStop += e;
      st.vx = 0;
    }
    if (phase === "out") phase = "brakeOut";
  } else if (st.x <= lo) {
    st.x = lo;
    if (st.vx < 0) {
      const e = 0.5 * mEff * st.vx * st.vx;
      st.stop += e;
      st.cycleStop += e;
      st.vx = 0;
    }
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
    // In a gale the sail never gets all the way back to face-on, so a cycle
    // closes when it is as far into the wind as the rail will allow.
    if (st.alpha <= st.feather + 0.05) {
      st.alpha = st.feather;
      phase = "out";
      st.cycles += 1;
      st.lastCycleS = st.cycleT;
      st.cycleT = 0;
      st.lastCycleNet =
        st.cycleGen - st.cycleMot - st.cycleSlew - st.cycleLoss - st.cycleStop;
      st.cycleGen = 0;
      st.cycleMot = 0;
      st.cycleSlew = 0;
      st.cycleLoss = 0;
      st.cycleStop = 0;
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
  // Copper scales with force squared and iron with speed squared, and both are
  // paid at every speed. The old model only charged copper while parked.
  const cu = s.cuMax * (fCmd / s.fMax) ** 2;
  const iron = (s.ironRef ?? 35) * (st.vx / 10) ** 2;
  const eLoss = (cu + iron) * dt;
  st.loss += eLoss;
  st.cycleLoss += eLoss;
  inst -= cu + iron;
  inst -= slewE / dt;

  st.phase = phase;
  st.force = fCmd;
  st.faero = faNow;
  st.inst = inst;
  st.time += dt;
  st.cycleT += dt;
}

export function step(st, dt) {
  const h = st.specs.h || 1 / 200;
  let left = Math.max(0, dt);
  while (left > 1e-8) {
    const d = Math.min(h, left);
    sub(st, d);
    left -= d;
  }
}

/** What the chosen plan actually does, for display next to the selector. */
export function planInfo(s) {
  const vOut = s.wind * s.outFrac;
  const fa = aeroForce(s, vOut, 0);
  return {
    vOut,
    turn: Math.max(0.15, s.turn),
    lead: Math.max(0, s.turnLead ?? 0),
    brakeM: brakeDist(s, vOut, fa, movingMass(s, 0)),
    torqueNm: slewTorque(s),
  };
}

/**
 * One settled cycle, frame by frame, so it can be scrubbed by hand. Frames are
 * evenly spaced in time, which is what makes the slider linear to drag.
 */
export function sampleCycle(specs, maxFrames = 1600) {
  const dt = 0.02;
  const st = createState(specs);
  let g = 0;
  while (st.cycles < 1 && g++ < 2000) step(st, dt);
  if (st.cycles < 1) return null;
  const mark = st.cycles;
  const frames = [];
  while (st.cycles === mark && frames.length < maxFrames) {
    frames.push({
      x: st.x,
      vx: st.vx,
      alpha: st.alpha,
      phase: st.phase,
      inst: st.inst,
      feather: st.feather,
      slip: st.slip,
    });
    step(st, dt);
  }
  if (frames.length < 2) return null;
  return { frames, seconds: frames.length * dt };
}

/** Average net watts over steady cycles. Returns null if it never settles. */
export function score(specs, cycles = 2) {
  const st = createState(specs);
  const dt = 0.02;
  // Caps are in simulated seconds: a plan that cannot turn a cycle inside
  // forty seconds is not a plan, and waiting on it is what made this slow.
  let guard = 0;
  while (st.cycles < 1 && guard++ < 2000) step(st, dt);
  if (st.cycles < 1) return null;
  const t0 = st.time;
  const a = st.gen, b = st.mot, c = st.slew, d = st.loss, e = st.stop;
  const target = st.cycles + cycles;
  guard = 0;
  while (st.cycles < target && guard++ < 4000) step(st, dt);
  if (st.cycles < target) return null;
  const T = st.time - t0;
  if (T <= 0) return null;
  return (st.gen - a - (st.mot - b) - (st.slew - c) - (st.loss - d) - (st.stop - e)) / T;
}

/**
 * Hunt for the outbound speed, slew time and lead that make the most power.
 * Coordinate descent: the three interact, but weakly enough that two passes
 * land on the same answer as a full grid at a fraction of the cost.
 */
export function solvePlan(specs) {
  const plan = {
    outFrac: specs.outFrac,
    turn: specs.turn,
    turnLead: specs.turnLead,
  };
  const axes = [
    ["outFrac", [0.12, 0.16, 0.2, 0.24, 0.28, 0.32, 0.36, 0.42, 0.5]],
    ["turn", [0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.4, 2]],
    ["turnLead", [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.9]],
  ];
  let best = score({ ...specs, ...plan }) ?? -Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, values] of axes) {
      for (const v of values) {
        const w = score({ ...specs, ...plan, [key]: v });
        if (w != null && w > best) {
          best = w;
          plan[key] = v;
        }
      }
    }
  }
  return { ...plan, avgW: best };
}

export function phaseLabel(phase) {
  switch (phase) {
    case "out":
      return "Out, face-on";
    case "brakeOut":
      return "Slowing out";
    case "turnEdge":
      return "Edge-on";
    case "back":
      return "Return, edge-on";
    case "brakeBack":
      return "Slowing home";
    case "turnFace":
      return "Face-on";
    default:
      return phase;
  }
}
