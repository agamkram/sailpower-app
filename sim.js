/** SailPower cycle. +x is downwind. Plate yaw 0 faces the wind, π/2 is edge-on. */

export function defaultSpecs() {
  return sizeMachine({
    wind: 10,
    track: 10,
    gauge: 1,
    plateW: 2,
    plateH: 5,
    sailRho: 1.6,
    rho: 1.225,
    thickness: 0.006,
    turn: 0.3,
    turnLead: 0.45,
    coilMode: "limited",
    vNoLoad: 22,
    ironRef: 35,
    slewRegen: 0,
    vReturn: 8,
    outFrac: 0.2,
    harvest: 18,
    cuMax: 120,
  });
}

/**
 * Carbon bogie under the sail. The plate's own weight is already in the sail
 * mass. What is left is the beam across the rail, the slewing ring, the guide
 * wheels, and the magnets that push with the rail.
 *
 * The beam is a thin carbon tube worked at 200 MPa, about a third of what the
 * fiber takes, so joints and fatigue sit inside the number. Section radius is
 * 60 mm: deep enough that bending stays light, low enough for a bogie. The
 * ring is a light alloy slewing bearing, the wheels are small rollers that
 * grip the rail from every side, and the magnets are a short high-field mover
 * at 4 kg per kN rather than an iron industrial forcer.
 */
const CARBON_STRESS = 200e6;
const CARBON_RHO = 1600;
const BOGIE_R = 0.06;
const PIVOT_H = 0.35;
const MAGNET_KG_PER_N = 0.004;

export function chassisMass(s, railN) {
  const push = Math.max(0, holdForce(s));
  const moment = push * (PIVOT_H + s.plateH / 2);
  const gauge = Math.max(0.4, s.gauge ?? 1);
  const beamArea = moment / (CARBON_STRESS * BOGIE_R);
  const beam = CARBON_RHO * beamArea * gauge;
  const frame = 1.2 + 4 * beam;
  const bearing = 1.2 + moment / 800;
  const wheels = 2 + moment / gauge / 5000;
  const magnets = MAGNET_KG_PER_N * Math.max(0, railN ?? push);
  return Math.round((frame + bearing + wheels + magnets) * 10) / 10;
}

/**
 * Rail and chassis for this sail in this wind. The rail is the greater of the
 * push that holds the sail still and the push that shifts the cart at 1 m/s².
 * The chassis is rebuilt around that rail, then the rail is read again so a
 * cart that had to grow still has the force to move itself.
 *
 * Rolling is steel rollers on the rail: 0.002 of the load. The load is
 * already the cart's weight plus the sail's push through the guide rollers,
 * so the coefficient is not inflated a second time.
 *
 * The inverter is 98%. Coil copper and iron are already their own loss,
 * so this is only the power electronics, one stage, each way.
 */
const ROLLING = 0.002;
const DRIVE = 0.98;

export function sizeMachine(s) {
  const push = holdForce(s);
  let mass = chassisMass(s, push);
  // Newtons to shift the whole cart at 1 m/s². Same number as the mass in kg.
  let fMax = Math.max(push, rig({ ...s, mass }).total);
  mass = chassisMass(s, fMax);
  fMax = Math.max(push, rig({ ...s, mass }).total);
  return { ...s, mass, fMax, crr: ROLLING, eta: DRIVE };
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

/**
 * Most face-on the sail may be while the cart still has to reach the home cap.
 * Opening past this lets the wind blow the cart back down the track, the
 * time-to-arrival goes infinite, and the turn is commanded shut, so the last
 * stretch home is taken edge-on at a crawl. The rest of the turn happens at
 * the cap, which is where a strong wind is allowed to start the power stroke.
 */
function approachYaw(s, vx) {
  const r = rig(s);
  // Upwind of a crawl, the force toward home is the motoring limit and it
  // droops with speed. Once the cart has stopped or been blown the other way,
  // holding is the full brake.
  const towardHome = vx < -0.05 ? forceLimit(s, vx, true) : forceLimit(s, vx, false);
  const spare = Math.max(0, towardHome - r.total * 9.81 * (s.crr ?? 0) - 60);
  const vRel = vx - s.wind;
  const q = 0.5 * s.rho * vRel * vRel;
  const full = q * r.cd * r.area;
  if (full <= spare || full <= 0) return 0;
  return Math.acos(Math.sqrt(clamp(spare / full, 0, 1)));
}

/** Centre-of-pressure offset as a fraction of chord, for the slew torque. */
const SLEW_CP = 0.1;

/**
 * Everything that follows from the sail's shape rather than just its area.
 * Two sails of equal area behave differently: a wide one is far harder to yaw,
 * and a stubby one drags more air with it. The push itself is the harvest.
 *
 * cd       set by harvest. A drag device peaks at one-third of wind speed,
 *          where the share of the wind kept is Cd×4/27, so Cd is the
 *          harvest share times 27/4. There is no separate grabbiness.
 * inertia  yaw inertia about the vertical pivot, m*w^2/12. Scales with width
 *          squared, so this is what separates a 5x2 sail from a 2x5 one.
 * added    air entrained when the plate moves normal to itself. Conservative,
 *          so it shifts timing and peak force rather than the watt-seconds.
 */
export function rig(s) {
  const area = s.plateW * s.plateH;
  const span = Math.max(s.plateW, s.plateH);
  const chord = Math.min(s.plateW, s.plateH);
  const ar = Math.min(20, Math.max(1, chord > 0 ? span / chord : 1));
  const h = Math.max(0, s.harvest == null ? 18 : s.harvest) / 100;
  const cd = h * (27 / 4);
  const sailMass = (s.sailRho ?? 1.6) * area;
  const inertia = (sailMass * s.plateW * s.plateW) / 12;
  const added = s.rho * (Math.PI / 4) * chord * chord * span * (1 - 0.42 / ar ** 0.8);
  return { area, ar, cd, sailMass, total: s.mass + sailMass, inertia, added };
}

/** Peak torque a real accelerate-then-decelerate slew would need, N m. */
export function slewTorque(s) {
  return (rig(s).inertia * 2 * Math.PI) / Math.max(0.15, s.turn) ** 2;
}

/** Face-on push with the cart at rest: the worst the rail ever has to hold. */
export function holdForce(s) {
  return Math.abs(aeroForce({ ...s, thickness: s.thickness ?? 0.006 }, 0, 0));
}

/** Torque the slew drive is built for. A bigger sail gets a bigger drive. */
const SLEW_NM_PER_M2 = 150;

/**
 * Quickest 90° the slew drive can actually turn this sail. Inertia goes as
 * area times width squared and the drive only goes as area, so this comes out
 * as a flat 0.075 s per metre of width: a 2 m sail can snap round in 0.15 s,
 * an 8 m sail needs 0.6 s however the drive is sized.
 */
export function turnFloor(s) {
  const r = rig(s);
  const ceiling = SLEW_NM_PER_M2 * Math.max(0.1, r.area);
  return Math.sqrt((r.inertia * 2 * Math.PI) / ceiling);
}

/**
 * Fastest the cart can be hauled home. Motoring force droops with back-EMF
 * and is gone at vNoLoad, so a weak rail under a big sail simply cannot reach
 * the speed the slider used to offer.
 */
export function returnCeiling(s) {
  const vnl = Math.max(1, s.vNoLoad ?? 22);
  let best = 1;
  for (let v = 1; v <= 16.0001; v += 0.5) {
    const drag = Math.abs(aeroForce(s, -v, Math.PI / 2));
    const roll = (s.crr ?? 0) * (rig(s).total * 9.81 + drag);
    // Reaching a speed is not the same as holding it. Ask for most of the
    // force back as margin, or the cruise sits pinned against the limit.
    if (forceLimit(s, v, true) < 1.8 * (drag + roll)) break;
    best = v;
  }
  return best;
}

/**
 * Slider ends that follow the machine. The sail and the wind are free. Rail
 * force and chassis mass are already fixed by sizeMachine. What is left is a
 * slew no faster than the drive can turn this sail, and a return no faster
 * than the coils can still hold.
 */
export function ranges(s) {
  const sized = sizeMachine(s);
  const tMin = Math.max(0.1, Math.ceil(turnFloor(sized) * 10) / 10);
  return {
    turn: { min: tMin, max: Math.max(tMin + 0.1, 3), step: 0.1 },
    vReturn: { min: 1, max: returnCeiling(sized), step: 0.5 },
  };
}

/**
 * A rotation plan is two numbers. `turn` is how long the 90° slew takes.
 * `turnLead` is where that slew sits relative to arrival, as a fraction of its
 * own length: 0 starts it once the cart is stopped, 1 finishes it exactly as
 * the cart stops. Measuring it in bare seconds made one setting mild on the
 * slow outbound run and ruinous on the fast return, where it left the sail
 * wide open metres from home with the motor still hauling against it.
 */
export const PRESETS = [
  { id: "stopped", name: "Once stopped", turnLead: 0 },
  { id: "arrive", name: "Mostly stopped", turnLead: 0.3 },
  { id: "slowing", name: "While slowing", turnLead: 0.6 },
  { id: "early", name: "Done on arrival", turnLead: 1 },
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
  const s = sizeMachine(specs);
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
    // Watt-seconds. Divide by time before anything on screen.
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
    avgNet: 0,
    avgT: 0,
    lastGen: 0,
    lastMot: 0,
    lastSlew: 0,
    lastLoss: 0,
    lastStop: 0,
  };
}

export function netOf(st) {
  return st.gen - st.mot - st.slew - st.loss - st.stop;
}

/**
 * Average net power over whole cycles, or null before the first one closes.
 *
 * The cart starts at the home cap face-on, which is where a cycle begins, so
 * there is no settling transient to discard: cycle one already runs at the
 * steady figure. What does mislead is the cycle in progress. Dividing the
 * running total by the running clock counts a part-finished cycle that has
 * taken the power stroke and not yet paid for the trip home, and on a machine
 * with a long cycle that reads tens of percent high.
 */
export function avgWatts(st) {
  return st.avgT > 0 ? st.avgNet / st.avgT : null;
}

/**
 * This cycle so far, as watts. Energy banked since the cap divided by the
 * time since the cap, so the column moves while the cart is moving and
 * starts over when the cycle does. A cycle that has not begun yet falls
 * back to the one that just finished.
 */
export function cycleWatts(st) {
  // The closing step starts the next cycle with a few milliseconds on the
  // clock. That sliver is not a reading yet; keep showing the cycle that
  // just finished until this one has something to divide by.
  const open = st.cycleT > 0.05;
  const t = open ? st.cycleT : st.lastCycleS;
  if (!(t > 0)) return null;
  const made = open ? st.cycleGen : st.lastGen;
  const motor = open ? st.cycleMot : st.lastMot;
  const slew = open ? st.cycleSlew : st.lastSlew;
  const loss = open ? st.cycleLoss : st.lastLoss;
  const stop = open ? st.cycleStop : st.lastStop;
  return {
    made: made / t,
    motor: motor / t,
    slew: slew / t,
    loss: loss / t,
    stop: stop / t,
    net: (made - motor - slew - loss - stop) / t,
  };
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function limits(s) {
  const { lo, hi } = stroke(s);
  return { lo, hi };
}

/** Power in the wind through the sail, watts. */
export function windPower(s) {
  const area = Math.max(0, s.plateW * s.plateH);
  const v = Math.max(0, s.wind);
  return 0.5 * (s.rho ?? 1.225) * area * v * v * v;
}

/** Watts kept from that wind. 18 is the drag ceiling. */
export function harvestWatts(s) {
  const h = s.harvest == null ? 18 : s.harvest;
  return (h / 100) * windPower(s);
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
  const cap = forceLimit(s, speed, false);
  // The sail turns away while braking, so never assume it keeps pushing at
  // full face-on load. Without this the stopping distance blows up and the
  // cart enters the brake at the top of the stroke.
  const push = Math.min(speed >= 0 ? Math.max(0, fa) : Math.max(0, -fa), cap * 0.9);
  const net = cap - push;
  // No spare brake at all means there is nothing to stop with. A few tens of
  // newtons is still a stop: a 300 N rail held to 90% has 30 N left, and that
  // halts a light cart in a few metres. Treating that as impossible made the
  // cart creep a whole long track and never be counted as a cycle.
  if (net <= 1) return Math.abs(speed) > 0.4 ? 1e6 : 0.15;
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
  const r = Math.max(0, remaining);
  // A standing cart is either already there or has not set off yet. Reading
  // both as "no time left" started the turn the instant each stroke launched,
  // which put a stray nudge on the sail at one cap and left the real turn to
  // happen late at the other.
  if (r <= 0.08) return 0;
  if (speed <= 0.05) return Infinity;
  return (r + Math.min(r, brake)) / speed;
}

/**
 * Closing speed for the last stretch into a cap. Braking only promises to stop
 * the cart, and in strong wind it stops it short; without this the cart parks
 * a metre out with nothing commanding it the rest of the way in.
 */
function creep(gap) {
  return Math.min(0.5, Math.max(0, gap - 0.02) * 3);
}

/** Bank one cycle and start the next. Returns the phase to run from. */
function closeCycle(st) {
  st.alpha = 0;
  st.cycles += 1;
  st.lastCycleS = st.cycleT;
  st.cycleT = 0;
  st.lastGen = st.cycleGen;
  st.lastMot = st.cycleMot;
  st.lastSlew = st.cycleSlew;
  st.lastLoss = st.cycleLoss;
  st.lastStop = st.cycleStop;
  st.lastCycleNet = st.lastGen - st.lastMot - st.lastSlew - st.lastLoss - st.lastStop;
  st.avgNet += st.lastCycleNet;
  st.avgT += st.lastCycleS;
  st.cycleGen = 0;
  st.cycleMot = 0;
  st.cycleSlew = 0;
  st.cycleLoss = 0;
  st.cycleStop = 0;
  return "out";
}

function sub(st, dt) {
  const s = st.specs;
  const { lo, hi } = limits(s);
  const fa = aeroForce(s, st.vx, st.alpha);
  const fr = rollForce(s, st.vx, fa);
  let phase = st.phase;
  const turnSec = Math.max(0.15, s.turn);
  const lead = clamp(s.turnLead ?? 0, 0, 1) * turnSec;
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

  // The sail is commanded, not committed. Within `lead` of arriving it drives
  // toward the angle that stroke ends on; outside that it drives back to the
  // angle the stroke runs at. A one-way turn let a sail that opened too early
  // keep opening while the wind drove the cart backwards, until it sat pinned
  // against the far cap half open with nothing left to try.
  const drive = (to) =>
    to > st.alpha
      ? Math.min(to, st.alpha + turnRate * dt)
      : Math.max(to, st.alpha - turnRate * dt);
  if (phase === "out" || phase === "brakeOut") {
    st.alpha = drive(timeToRest(hi - st.x, st.vx, brake) <= lead ? Math.PI / 2 : 0);
  } else if (phase === "back" || phase === "brakeBack") {
    const arriving = timeToRest(st.x - lo, -st.vx, brake) <= lead;
    st.alpha = drive(arriving ? approachYaw(s, st.vx) : Math.PI / 2);
  } else if (phase === "turnEdge") {
    st.alpha = Math.min(Math.PI / 2, st.alpha + turnRate * dt);
  } else if (phase === "turnFace") {
    st.alpha = Math.max(0, st.alpha - turnRate * dt);
  }

  // The rail can still be overpowered. Record it, but do not turn the sail
  // to shed it. Doing that made width start a second rotation: a wide plate
  // flipped to edge on the way out, then flipped back to face at home.
  // The Turn slider is the only thing that turns the sail.
  const shedding = phase === "brakeOut" || phase === "turnEdge";
  st.feather = shedding ? featherFloor(s, st.vx) : 0;

  // Work the slew drive does. A real slew accelerates through the first
  // half of the 90° and brakes through the second. The spin energy is
  // spent across that first half, not dumped into one step; spin-down
  // goes into the brake unless slewRegen buys it back onto the bus.
  const dAlpha = Math.abs(st.alpha - alpha0);
  const slewing = dAlpha > 1e-9;
  const spinKE = 0.5 * rg.inertia * turnRate * turnRate;
  let slewE = 0;
  if (slewing) {
    const half = Math.PI / 4;
    const accel = st.alpha > alpha0 ? st.alpha < half : st.alpha > half;
    const share = dAlpha / half;
    if (accel) slewE += (spinKE / s.etaM) * share;
    else slewE -= spinKE * s.etaG * (s.slewRegen ?? 0) * share;
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
      const gap = hi - st.x;
      const vClose = creep(gap);
      // The stop-at-the-cap profile and the creep used to switch at 0.05 m/s,
      // below the creep itself, so each undid the other and the last fraction
      // of a metre took several seconds.
      aDes = st.vx > vClose ? -(st.vx * st.vx) / (2 * Math.max(0.12, gap)) : 4 * (vClose - st.vx);
    } else {
      const gap = st.x - lo;
      const vClose = creep(gap);
      aDes = st.vx < -vClose ? (st.vx * st.vx) / (2 * Math.max(0.12, gap)) : 4 * (-vClose - st.vx);
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

  // Bank this step before the cycle is allowed to close, so the closing step
  // belongs to the cycle it finished and the next one starts from zero.
  // Harvest is the share of the wind through the sail. The inverter keeps
  // 98% of it on the power stroke. The push is that same share, not a
  // second drag setting. The return adds none.
  const mech = -fCmd * st.vx;
  const harvesting = phase === "out" || phase === "brakeOut";
  if (harvesting) {
    const e = harvestWatts(s) * (s.eta ?? DRIVE) * dt;
    st.gen += e;
    st.cycleGen += e;
  }
  if (mech < 0) {
    const e = (-mech / s.etaM) * dt;
    st.mot += e;
    st.cycleMot += e;
  }
  const cu = s.cuMax * (fCmd / s.fMax) ** 2;
  const iron = (s.ironRef ?? 35) * (st.vx / 10) ** 2;
  const eLoss = (cu + iron) * dt;
  st.loss += eLoss;
  st.cycleLoss += eLoss;
  st.time += dt;
  st.cycleT += dt;

  const parked = Math.abs(st.vx) < 0.15;
  if ((phase === "brakeOut" || phase === "turnEdge") && parked && st.x > hi - 0.08) {
    st.vx = 0;
    st.x = hi;
    // The return starts when the face load has fallen into the edge load.
    // That is a few degrees from edge-on at every wind. Leaving sooner is the
    // motor pushing against a plate, which is not this machine.
    if (st.alpha >= Math.PI / 2 - 0.05) {
      st.alpha = Math.PI / 2;
      phase = "back";
    } else phase = "turnEdge";
  } else if ((phase === "brakeBack" || phase === "turnFace") && parked && st.x < lo + 0.08) {
    st.vx = 0;
    st.x = lo;
    if (st.alpha <= 0.05) phase = closeCycle(st);
    else phase = "turnFace";
  }
  // A strong wind pulls the cart off the home cap before the sail is all the
  // way round. That is the power stroke starting early, not a stall, so the
  // cycle turns over on sail angle rather than on sitting still at the cap.
  if (phase === "turnFace" && st.alpha <= 0.05) phase = closeCycle(st);

  st.phase = phase;
  st.force = fCmd;
  st.faero = faNow;
}

export function step(st, dt) {
  const h = st.specs.h || 1 / 200;
  let left = Math.max(0, dt);
  const net0 = netOf(st);
  const t0 = st.time;
  while (left > 1e-8) {
    const d = Math.min(h, left);
    sub(st, d);
    left -= d;
  }
  // Power for the frame, read off the ledger and averaged over the frame, so
  // the bar integrates to the net beside it. Taking the last substep instead
  // aliased everything impulsive: a slew spin-up or an end-stop hit lands in
  // one 5 ms substep, so a 20 ms frame either caught it at four times its
  // weight or missed it outright. It also never charged the end stop at all.
  const span = st.time - t0;
  if (span > 0) st.inst = (netOf(st) - net0) / span;
}

/** What the chosen plan actually does, for display next to the selector. */
export function planInfo(s) {
  const vOut = s.wind * s.outFrac;
  const fa = aeroForce(s, vOut, 0);
  return {
    vOut,
    turn: Math.max(0.15, s.turn),
    lead: clamp(s.turnLead ?? 0, 0, 1) * Math.max(0.15, s.turn),
    brakeM: brakeDist(s, vOut, fa, movingMass(s, 0)),
    torqueNm: slewTorque(s),
  };
}

/**
 * Largest |watts| that lasts more than a single frame. The slew drive dumps its
 * spin-up into one step, and that spike is not motoring, braking, or generation.
 */
function sustainedPeak(values) {
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const a = Math.abs(values[i]);
    if (i > 0 && i + 1 < values.length) {
      const neigh = Math.max(Math.abs(values[i - 1]), Math.abs(values[i + 1]));
      if (a > neigh * 2 + 500) continue;
    }
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * One settled cycle, frame by frame, so it can be scrubbed by hand. Frames are
 * evenly spaced in time, which is what makes the slider linear to drag.
 * `span` is the bar's full scale: that sustained peak, plus a thousand watts
 * of room so the hardest stop in the cycle does not pin the meter.
 */
export function sampleCycle(specs, maxFrames = 5000) {
  // Coarsen the step rather than stop early, so a long cycle is scrubbed end
  // to end instead of being cut off part way round.
  const dt = Math.max(0.02, Math.ceil((cycleBudget(specs) / maxFrames) * 500) / 500);
  const st = createState(specs);
  // A small sail on a long track in light air takes well over a minute to come
  // round. A short window reports that working plan as no plan at all.
  let g = 0;
  const cap = cycleBudget(specs) / dt;
  while (st.cycles < 1 && g++ < cap) step(st, dt);
  if (st.cycles < 1) return null;
  const mark = st.cycles;
  const frames = [];
  while (st.cycles === mark && frames.length < maxFrames) {
    // Position is the state at this instant; power is the frame that starts
    // here. Filling it in after the step is what makes the trace sum to the
    // cycle's net exactly rather than to the frame before it.
    const f = {
      x: st.x,
      vx: st.vx,
      alpha: st.alpha,
      phase: st.phase,
      inst: 0,
      feather: st.feather,
      slip: st.slip,
    };
    frames.push(f);
    const banked = { gen: st.gen, mot: st.mot, slew: st.slew, loss: st.loss, stop: st.stop };
    step(st, dt);
    f.inst = st.inst;
    f.ledger = cycleWatts(st);
    f.rate = {
      made: (st.gen - banked.gen) / dt,
      motor: (st.mot - banked.mot) / dt,
      slew: (st.slew - banked.slew) / dt,
      loss: (st.loss - banked.loss) / dt,
      stop: (st.stop - banked.stop) / dt,
      net: st.inst,
    };
  }
  if (frames.length < 2) return null;
  const peak = sustainedPeak(frames.map((f) => f.inst));
  const T = st.lastCycleS;
  const totals = T > 0
    ? {
        made: st.lastGen / T,
        motor: st.lastMot / T,
        slew: st.lastSlew / T,
        loss: st.lastLoss / T,
        stop: st.lastStop / T,
        net: st.lastCycleNet / T,
      }
    : null;
  return { frames, seconds: frames.length * dt, span: peak + 1000, totals };
}

/**
 * Generous seconds for one cycle at these specs: out, back, four slews and
 * some slack. A flat forty-second cap called a slow machine no plan at all —
 * a long track crossed at a crawl is a bad design, not an impossible one, and
 * the tool should say so in watts rather than refusing to run it.
 */
function cycleBudget(s) {
  const out = s.track / Math.max(0.2, s.wind * s.outFrac);
  const home = s.track / Math.max(0.2, Math.abs(s.vReturn));
  const est = out + home + 4 * Math.max(0.15, s.turn) + 6;
  // Bounded, or Best spends seconds chasing a machine nobody would build.
  // The slowest real cycle in the slider space is a 40 m track crawled at
  // 0.2 m/s, which is inside 400 s with room to spare.
  return Math.min(400, Math.max(60, 2.5 * est));
}

/** Average net watts over steady cycles. Returns null if it never settles. */
export function score(specs, cycles = 2, dt = 0.02) {
  const st = createState(specs);
  const cap = cycleBudget(specs) / dt;
  let guard = 0;
  while (st.cycles < 1 && guard++ < cap) step(st, dt);
  if (st.cycles < 1) return null;
  const t0 = st.time;
  const b = st.mot, c = st.slew, d = st.loss, e = st.stop;
  const target = st.cycles + cycles;
  guard = 0;
  while (st.cycles < target && guard++ < cap * cycles) step(st, dt);
  if (st.cycles < target) return null;
  const T = st.time - t0;
  if (T <= 0) return null;
  const costs = (st.mot - b) + (st.slew - c) + (st.loss - d) + (st.stop - e);
  return harvestWatts(st.specs) * (st.specs.eta ?? DRIVE) - costs / T;
}

/**
 * Hunt for the outbound speed, return speed, slew time and lead that make
 * the most power. Coordinate descent: they interact, but weakly enough that
 * two passes land on the same answer as a full grid at a fraction of the cost.
 */
export function solvePlan(specs) {
  const lim = ranges(specs);
  const plan = {
    outFrac: specs.outFrac,
    vReturn: clamp(specs.vReturn, lim.vReturn.min, lim.vReturn.max),
    turn: clamp(specs.turn, lim.turn.min, lim.turn.max),
    turnLead: specs.turnLead,
  };
  // Best may only offer plans the machine can carry out. It used to hand back
  // a 0.2 s slew for a sail no drive could turn that fast.
  const inside = (key, values) =>
    values.filter((v) => v >= lim[key].min && v <= lim[key].max).concat(plan[key]);
  const axes = [
    ["outFrac", [0.16, 0.2, 0.24, 0.28, 0.32, 0.36, 0.42, 0.5]],
    ["vReturn", inside("vReturn", [4, 6, 8, 10, 12, 14, 16])],
    ["turn", inside("turn", [0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.4, 2])],
    ["turnLead", [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1]],
  ];
  // The cycle is periodic from the first stroke, so one cycle at a coarser
  // step ranks candidates to within a watt. Searching at full resolution
  // took most of ten seconds on a slow machine.
  const rank = (p) => score({ ...specs, ...p }, 1, 0.05);
  let best = rank(plan) ?? -Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, values] of axes) {
      for (const v of values) {
        const w = rank({ ...plan, [key]: v });
        if (w != null && w > best) {
          best = w;
          plan[key] = v;
        }
      }
    }
  }
  return { ...plan, avgW: score({ ...specs, ...plan }) ?? best };
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
