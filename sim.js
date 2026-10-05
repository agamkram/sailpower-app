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
    turn: 0.5,
    turnLead: 0.45,
    vNoLoad: 22,
    slewRegen: 0,
    vReturn: 10,
    outFrac: 0.24,
    harvest: 18,
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

/**
 * Copper and iron for the opening machine's 749 N rail. A bigger rail is a
 * bigger motor, so both losses grow with the force it is built to hold.
 * Leaving them fixed charged a 0.4 m² sail with a 120 W heater.
 */
const LOSS_REF_N = 749;
const CU_AT_REF = 120;
const IRON_AT_REF = 35;

export function sizeMachine(s) {
  const push = holdForce(s);
  let mass = chassisMass(s, push);
  // Newtons to shift the whole cart at 1 m/s². Same number as the mass in kg.
  let fMax = Math.max(push, rig({ ...s, mass }).total);
  mass = chassisMass(s, fMax);
  fMax = Math.max(push, rig({ ...s, mass }).total);
  const scale = Math.max(0, fMax) / LOSS_REF_N;
  return {
    ...s,
    mass,
    fMax,
    crr: ROLLING,
    eta: DRIVE,
    cuMax: CU_AT_REF * scale,
    ironRef: IRON_AT_REF * scale,
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

/** Skin drag on sail area. Taken out of the harvest budget, not added on top. */
const SKIN_CD = 0.008;

/**
 * Everything that follows from the sail's shape rather than just its area.
 * Two sails of equal area behave differently: a wide one is far harder to yaw,
 * and a stubby one drags more air with it. The push itself is the harvest.
 *
 * cd       face drag after skin has taken its share of the harvest budget.
 *          A drag device peaks at one-third of wind speed, where the share
 *          of the wind kept is Cd×4/27. The slider is that share, and skin
 *          is inside it, so a sail set to 100% cannot take more than the wind.
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
  const budget = h * (27 / 4);
  const skin = Math.min(SKIN_CD, budget);
  const cd = budget - skin;
  const sailMass = (s.sailRho ?? 1.6) * area;
  const inertia = (sailMass * s.plateW * s.plateW) / 12;
  const added = s.rho * (Math.PI / 4) * chord * chord * span * (1 - 0.42 / ar ** 0.8);
  return { area, ar, cd, skin, sailMass, total: s.mass + sailMass, inertia, added };
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
  const skin = dir * q * r.skin * r.area;
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
  const push = speed >= 0 ? Math.max(0, fa) : Math.max(0, -fa);
  const net = cap - push;
  // No spare brake at all means there is nothing to stop with. A few tens of
  // newtons is still a stop: a light cart on a 300 N rail with 30 N left
  // halts in a few metres. Treating that as impossible made the cart creep
  // a whole long track and never be counted as a cycle.
  if (net <= 1) return Math.abs(speed) > 0.4 ? 1e6 : 0.15;
  const a = (net / Math.max(5, mEff)) * 0.85;
  return (speed * speed) / (2 * a) + 0.3;
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
  // happen late at the other. Distance alone cannot tell the two apart, so
  // this asks for the park speed as well: inside the last few centimetres
  // and already down to a crawl is arrival. Reading the whole last 8 cm as
  // arrival whatever the speed charged every setting a fixed 0.12 s of lead,
  // which is a quarter of a half-second turn and most of a fast one.
  if (r <= 0.08 && speed < 0.15) return 0;
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

  // Work the slew drive does. The turn limit assumes the sail speeds up
  // through the first 45° and slows through the second, so the peak rate is
  // twice the steady rate that finishes the 90° in `turn` seconds, and the
  // stored energy is four times a steady yaw. That energy is spent across
  // the first half, not dumped into one step; spin-down goes into the brake
  // unless slewRegen buys it back onto the bus.
  const dAlphaSigned = st.alpha - alpha0;
  const dAlpha = Math.abs(dAlphaSigned);
  const slewing = dAlpha > 1e-9;
  const peakRate = Math.PI / turnSec;
  const spinKE = 0.5 * rg.inertia * peakRate * peakRate;
  let slewE = 0;
  if (slewing) {
    const half = Math.PI / 4;
    const accel = dAlphaSigned > 0 ? st.alpha < half : st.alpha > half;
    const share = dAlpha / half;
    if (accel) slewE += (spinKE / s.etaM) * share;
    else slewE -= spinKE * s.etaG * (s.slewRegen ?? 0) * share;
    const vRel = st.vx - s.wind;
    const q = 0.5 * s.rho * vRel * vRel;
    const lever = SLEW_CP * s.plateW;
    const tAero =
      q * rg.cd * rg.area * lever * Math.abs(Math.sin(st.alpha) * Math.cos(st.alpha));
    // The plate weathercocks toward edge-on. Yawing back toward the wind
    // fights that moment and the drive pays for it. Yawing toward edge-on
    // is helped; the brake absorbs it unless slew regen is on.
    const regen = s.slewRegen ?? 0;
    if (dAlphaSigned < 0) slewE += (tAero * dAlpha) / s.etaM;
    else slewE -= tAero * dAlpha * s.etaG * regen;
  }
  st.slewing = slewing;
  st.slew += slewE;
  st.cycleSlew += slewE;

  const faNow = aeroForce(s, st.vx, st.alpha);
  let aDes = 0;
  if (phase === "out") aDes = 4 * (vOut - st.vx);
  else if (phase === "back") aDes = 4 * (-Math.abs(s.vReturn) - st.vx);
  else if (phase === "brakeOut" || phase === "turnEdge") {
    const gapRaw = hi - st.x;
    const gap = Math.max(0.02, gapRaw);
    const vClose = creep(gapRaw);
    // Stay on the stop-at-the-cap curve until the cart is in the last
    // stretch or already slower than the creep. Switching at 0.5 m/s a
    // metre out left it cruising into the bumper; flooring the gap at
    // 0.12 m then asked for a gentle last decimetre and charged a hit.
    const closing = gapRaw > 0.2 && st.vx > 0.05;
    aDes = closing || st.vx > vClose
      ? -(st.vx * st.vx) / (2 * gap)
      : 4 * (vClose - st.vx);
  } else {
    const gapRaw = st.x - lo;
    const gap = Math.max(0.02, gapRaw);
    const vClose = creep(gapRaw);
    const closing = gapRaw > 0.2 && st.vx < -0.05;
    aDes = closing || st.vx < -vClose
      ? (st.vx * st.vx) / (2 * gap)
      : 4 * (-vClose - st.vx);
  }
  const up = st.vx >= 0 ? forceLimit(s, st.vx, true) : forceLimit(s, st.vx, false);
  const dn = st.vx >= 0 ? forceLimit(s, st.vx, false) : forceLimit(s, st.vx, true);
  const aMin = (faNow + fr - dn) / mEff;
  const aMax = (faNow + fr + up) / mEff;
  const aUse = clamp(aDes, aMin, aMax);
  const coilLimited = Math.abs(aUse - aDes) > 0.2;
  const fCmd = mEff * aUse - faNow - fr;
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
  // Generation is the mechanical power through the coils, after the inverter.
  // A flat share of the wind paid that rate while the cart sat still and
  // while the sail was edge-on, so a slower return looked like more watts.
  const mech = -fCmd * st.vx;
  if (mech >= 0) {
    const e = mech * s.etaG * dt;
    st.gen += e;
    st.cycleGen += e;
  } else {
    const e = (-mech / s.etaM) * dt;
    st.mot += e;
    st.cycleMot += e;
  }
  const cu = s.fMax > 0 ? s.cuMax * (fCmd / s.fMax) ** 2 : 0;
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
  let homePeak = 0;
  for (const f of frames) {
    if ((f.phase === "back" || f.phase === "brakeBack") && -f.vx > homePeak) homePeak = -f.vx;
  }
  // How far round the sail has actually come at the instant the cart is held,
  // taken at whichever cap manages less. The lead slider asks for a fraction
  // of the turn; the drive, the brake and the wind decide what it gets, and
  // coming home the wind decides most of it.
  const quarter = Math.PI / 2;
  const arrival = (onLeg) => {
    for (let i = 1; i < frames.length; i++) {
      if (onLeg(frames[i - 1].phase) && !onLeg(frames[i].phase)) return frames[i].alpha;
    }
    return null;
  };
  const aOut = arrival((p) => p === "out" || p === "brakeOut");
  const aHome = arrival((p) => p === "back" || p === "brakeBack");
  const madeOut = aOut == null ? 1 : aOut / quarter;
  const madeHome = aHome == null ? 1 : (quarter - aHome) / quarter;
  const leadMade = clamp(Math.min(madeOut, madeHome), 0, 1);
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
  return { frames, seconds: frames.length * dt, span: peak + 1000, totals, homePeak, leadMade };
}

/**
 * Generous seconds for one cycle at these specs: out, back, four slews and
 * some slack. A flat forty-second cap called a slow machine no plan at all —
 * a long track crossed at a crawl is a bad design, not an impossible one, and
 * the tool should say so in watts rather than refusing to run it.
 */
function cycleBudget(s) {
  const vOut = Math.abs((s.wind ?? 0) * (s.outFrac ?? 0));
  // No wind means the cart never leaves. A short budget reports that as no
  // plan instead of integrating a crawl that cannot start.
  if (!(vOut > 1e-3)) return 60;
  const vHome = Math.max(vOut, Math.abs(s.vReturn ?? 0));
  const est = s.track / vOut + s.track / vHome + 4 * Math.max(0.15, s.turn) + 6;
  // The slowest slider corner is a 40 m track at 0.075 m/s, about nine
  // minutes outbound. 2.5× that still fits, so the corner reports watts.
  return Math.min(1800, Math.max(60, 2.5 * est));
}

/** Average net watts over steady cycles. Returns null if it never settles. */
export function score(specs, cycles = 2, dt = 0.02) {
  const st = createState(specs);
  const cap = cycleBudget(specs) / dt;
  let guard = 0;
  while (st.cycles < 1 && guard++ < cap) step(st, dt);
  if (st.cycles < 1) return null;
  const t0 = st.time;
  const a = st.gen, b = st.mot, c = st.slew, d = st.loss, e = st.stop;
  const target = st.cycles + cycles;
  guard = 0;
  while (st.cycles < target && guard++ < cap * cycles) step(st, dt);
  if (st.cycles < target) return null;
  const T = st.time - t0;
  if (T <= 0) return null;
  return (st.gen - a - (st.mot - b) - (st.slew - c) - (st.loss - d) - (st.stop - e)) / T;
}

/**
 * Hunt for the outbound speed, return speed, slew time and lead that make
 * the most power. Coordinate descent: they interact, but weakly enough that
 * two passes land on the same answer as a full grid at a fraction of the cost.
 *
 * Bounded by the clock, not by the candidate count. A 40 m track crawled at
 * 0.075 m/s takes nine minutes of simulated time per candidate, and seventy
 * candidates of that is a minute of a phone sitting still. The axes are in
 * order of what they are worth, so a search that runs out of time has already
 * spent it on the settings that move the watts.
 */
export function solvePlan(specs, msBudget = 2500) {
  const started = Date.now();
  const spent = () => Date.now() - started > msBudget;
  const lim = ranges(specs);
  const plan = {
    outFrac: specs.outFrac,
    vReturn: clamp(specs.vReturn, lim.vReturn.min, lim.vReturn.max),
    turn: clamp(specs.turn, lim.turn.min, lim.turn.max),
    turnLead: specs.turnLead,
  };
  // The cycle is periodic from the first stroke, so one cycle at a coarser
  // step ranks candidates to within a watt. Searching at full resolution
  // took most of ten seconds on a slow machine.
  const rank = (p) => score({ ...specs, ...p }, 1, 0.05);
  const probe = Date.now();
  let best = rank(plan) ?? -Infinity;
  // How many settings this machine can afford to try. A nine-minute cycle
  // costs a third of a second to rank, so the full sweep would spend a
  // minute. Thin every axis instead of sweeping the first one and running
  // out of clock before the other three are touched.
  const room = msBudget / Math.max(1, Date.now() - probe);
  const full = room >= 80;
  const per = full ? 99 : Math.max(2, Math.floor(room / 5));
  // Thin what the machine can actually set, not the raw list, or a sail with
  // a 10 m/s ceiling is offered 1 and 16 and ends up trying one of them.
  // Best may only offer plans the machine can carry out: it used to hand back
  // a 0.2 s slew for a sail no drive could turn that fast.
  const pick = (key, values) => {
    const legal = lim[key]
      ? values.filter((v) => v >= lim[key].min && v <= lim[key].max)
      : values;
    return [...new Set(thin(legal, per).concat(plan[key]))];
  };
  const axes = [
    ["outFrac", pick("outFrac", [0.15, 0.16, 0.2, 0.24, 0.28, 0.32, 0.36, 0.42, 0.5, 0.6])],
    ["vReturn", pick("vReturn", [1, 2, 4, 6, 8, 10, 12, 14, 16])],
    ["turn", pick("turn", [0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.4, 2, 3])],
    // Closely spaced below 0.6, because that is where the peak sits and it is
    // a narrow one. Jumping 0.45 to 0.6 stepped over the best lead on both a
    // half-second turn and a two-second one.
    ["turnLead", pick("turnLead", [0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1])],
  ];
  for (let pass = 0; pass < (full ? 2 : 1) && !spent(); pass++) {
    for (const [key, values] of axes) {
      for (const v of values) {
        if (spent()) break;
        const w = rank({ ...plan, [key]: v });
        if (w != null && w > best) {
          best = w;
          plan[key] = v;
        }
      }
    }
  }
  return { ...plan, avgW: score({ ...specs, ...plan }, full ? 2 : 1) ?? best };
}

/** At most `k` settings from a list, evenly spread, keeping both ends. */
function thin(values, k) {
  if (k >= values.length) return values;
  if (k <= 1) return [values[0]];
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(values[Math.round((i * (values.length - 1)) / (k - 1))]);
  }
  return [...new Set(out)];
}
