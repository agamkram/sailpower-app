/**
 * The slider ends move with the sail, so the guarantee worth testing is the
 * one the browser enforces for us: whatever a range input is left holding
 * after its min, max and step have moved is still a machine that runs.
 *
 * Stubs just enough of an <input type=range> to replay that clamping.
 */
import { defaultSpecs, fitError, ranges, score, sizeMachine, solvePlan, turnFloor } from "../sim.js";

/** What an <input type=range> does to its value when min/max/step move. */
function clampLikeInput(value, { min, max, step }) {
  const snapped = min + Math.round((value - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/** One round of what app.js does: move the ends, let the inputs clamp. */
function settle(specs) {
  let s = sizeMachine(specs);
  // Twice, because the return ceiling is read off the sized rail.
  for (let i = 0; i < 2; i++) {
    const lim = ranges(s);
    s = sizeMachine({
      ...s,
      turn: clampLikeInput(s.turn, lim.turn),
      vReturn: clampLikeInput(s.vReturn, lim.vReturn),
    });
  }
  return s;
}

let rnd = 20260404;
const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a, b, step) => a + Math.round((rand() * (b - a)) / step) * step;

const d = defaultSpecs();
const problems = [];
let tested = 0;

for (let i = 0; i < 300; i++) {
  // A saved machine from an older build, or a sail dragged to a new size:
  // either way the drive values arrive out of range and must come back in.
  const stale = {
    ...d,
    wind: pick(0.5, 20, 0.5),
    plateW: pick(1, 8, 0.1),
    plateH: pick(0.4, 5, 0.1),
    track: pick(8, 40, 1),
    mass: pick(10, 200, 1),
    outFrac: pick(0.15, 0.6, 0.01),
    harvest: pick(0, 100, 5),
    eta: pick(0.5, 0.98, 0.01),
    crr: pick(0.001, 0.04, 0.001),
    fMax: pick(200, 3000, 50),
    turn: pick(0.2, 3, 0.1),
    vReturn: pick(1, 16, 0.5),
  };
  const s = settle(stale);
  if (fitError(s)) continue;
  tested++;

  const lim = ranges(s);
  const built = sizeMachine(s);
  if (Math.abs(s.mass - built.mass) > 1e-9 || Math.abs(s.fMax - built.fMax) > 1e-6 || s.crr !== built.crr || s.eta !== built.eta) {
    problems.push(`stale chassis, rail, or rolling survived: ${JSON.stringify(s)}`);
    continue;
  }
  const at = (k) => s[k] >= lim[k].min - 1e-9 && s[k] <= lim[k].max + 1e-9;
  if (!at("turn") || !at("vReturn")) {
    problems.push(`settling did not converge: ${JSON.stringify(s)}`);
    continue;
  }
  if (s.turn < turnFloor(s) - 1e-9) {
    problems.push(`turn ${s.turn}s is faster than the drive can slew ${s.plateW} m`);
  }
  if (score(s) == null) problems.push(`no cycle: ${JSON.stringify(s)}`);

  const plan = solvePlan(s);
  if (plan.turn < turnFloor(s) - 1e-9 || plan.vReturn > lim.vReturn.max + 1e-9) {
    problems.push(`Best returned a plan the machine cannot run: ${JSON.stringify(plan)}`);
  }
}

console.log(`${tested} machines checked`);
if (problems.length) {
  for (const p of problems.slice(0, 10)) console.error("  " + p);
  console.error(`${problems.length} problems`);
  process.exit(1);
}
console.log("every slider position runs");
