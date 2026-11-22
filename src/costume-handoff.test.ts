import { describe, expect, it, vi } from "vite-plus/test";
import { restPose, Rig, type Pose } from "./costume-rig.ts";
import { CostumeSession } from "./costume-handoff.ts";
import type { CostumeName } from "./costumes.ts";

// Instrument the motion table: costume-handoff binds these names at module
// load, so the mock has to be hoisted above the import by vi.mock. Every test
// gets fresh call counts and can script the head pose a motion returns.
vi.mock("./costume-motion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./costume-motion.ts")>();
  return {
    ...actual,
    MOTIONS: new Proxy(actual.MOTIONS, {
      get(target, prop) {
        const motion = Reflect.get(target, prop) as ((t: number, rig: Rig) => unknown) | undefined;
        if (!motion) return motion;
        return (t: number, rig: Rig) => {
          motionCalls.push({ name: prop as string, t });
          return scriptedPose ?? motion(t, rig);
        };
      },
    }),
  };
});

let motionCalls: { name: string; t: number }[] = [];
let scriptedPose: Pose | null = null;

const SPRINGY: CostumeName = "patch";
const WAVY: CostumeName = "frank";

describe("CostumeSession.handoff", () => {
  it("restarts the rig's time base at zero and clears its spring state", () => {
    const rig = new Rig();
    rig.since(42);
    rig.state["lid"] = 3.2;
    rig.state["lid.v"] = -1.4;
    rig.state["lid.t"] = 9000;

    CostumeSession.handoff(SPRINGY, rig, restPose(), { intensity: 9 });

    expect(rig.state).toEqual({});
    // The old clock is forgotten: the next frame asked is the new t = 0.
    expect(rig.since(100)).toBe(0);
    expect(rig.since(100.5)).toBe(500);
  });

  it("zeroes the shared fire light and resets the head pose in the same handoff", () => {
    const rig = new Rig();
    const pose: Pose = { pitch: 0.4, yaw: 0.2, roll: -0.3, lift: 7 };
    const light = { intensity: 22 };

    const session = CostumeSession.handoff(WAVY, rig, pose, light);

    expect(light.intensity).toBe(0);
    expect(pose).toEqual(restPose());
    expect(session.name).toBe(WAVY);
  });

  it("chains rapid switches so every costume starts from rest and the last one wins", () => {
    const pose = restPose();
    const light = { intensity: 14 };
    const rigs = [new Rig(), new Rig(), new Rig()];
    const names: CostumeName[] = ["flame", "cauldron", WAVY];

    const sessions = names.map((name, i) => {
      rigs[i].since(10 + i);
      rigs[i].state["carry-over"] = i + 1;
      return CostumeSession.handoff(name, rigs[i], pose, light);
    });

    // Every handoff darkens the light; none keeps an earlier costume's value.
    expect(light.intensity).toBe(0);
    expect(pose).toEqual(restPose());
    rigs.forEach((rig) => {
      expect(rig.state).toEqual({});
      expect(rig.since(99)).toBe(0);
    });
    // The final selection is the session the stage keeps.
    expect(sessions.at(-1)?.name).toBe(WAVY);
  });
});

describe("CostumeSession.frame under reduced motion", () => {
  it("applies the t = 0 motion once and never recomputes on later frames", () => {
    motionCalls = [];
    const session = CostumeSession.handoff(SPRINGY, new Rig(), restPose(), { intensity: 0 });

    const first = session.frame(50, true);
    const second = session.frame(51, true);
    session.frame(99, true);

    expect(first).toMatchObject({ scale: 1, posed: true });
    expect(second).toEqual(first);
    expect(session.hasPosed).toBe(true);
    expect(motionCalls).toEqual([{ name: SPRINGY, t: 0 }]);
  });

  it("poses again exactly once after a new handoff (preview cancel returns to the selection)", () => {
    motionCalls = [];
    const rig = new Rig();
    const first = CostumeSession.handoff(SPRINGY, rig, restPose(), { intensity: 0 });
    first.frame(1, true);
    first.frame(2, true);
    expect(motionCalls).toHaveLength(1);

    // A second handoff is what ending/cancelling a preview triggers: the
    // selected costume gets a fresh stationary session, dark light first.
    const light = { intensity: 8 };
    const again = CostumeSession.handoff(SPRINGY, rig, restPose(), light);
    expect(light.intensity).toBe(0);
    expect(again.hasPosed).toBe(false);
    again.frame(3, true);
    again.frame(4, true);
    expect(motionCalls).toEqual([
      { name: SPRINGY, t: 0 },
      { name: SPRINGY, t: 0 },
    ]);
  });
});

describe("CostumeSession.frame in normal motion", () => {
  it("grows from a near-zero scale and writes the motion's head pose every frame", () => {
    motionCalls = [];
    scriptedPose = { pitch: 0, yaw: 0, roll: 0.12, lift: 2 };
    const rig = new Rig();
    const pose = restPose();
    const session = CostumeSession.handoff(WAVY, rig, pose, { intensity: 0 });

    const first = session.frame(10, false);
    // t = 0 on the first frame: effectively invisible, so no full-size flame
    // light can be measured before the grow-in has begun.
    expect(first.scale).toBeGreaterThan(0);
    expect(first.scale).toBeLessThan(1e-2);
    expect(first.posed).toBe(false);

    const later = session.frame(10.4, false);
    expect(later.scale).toBeGreaterThan(first.scale);
    // The motion's head pose is merged over rest on the same frame.
    expect(pose).toEqual(scriptedPose);

    const grown = session.frame(20, false);
    expect(grown.scale).toBe(1);
    expect(motionCalls.every((call) => call.name === WAVY)).toBe(true);
    expect(motionCalls).toHaveLength(3);
    scriptedPose = null;
  });

  it("recomputes scale and pose on every frame rather than caching them", () => {
    motionCalls = [];
    const pose = restPose();
    const session = CostumeSession.handoff(WAVY, new Rig(), pose, { intensity: 0 });

    const a = session.frame(5, false);
    const b = session.frame(5.1, false);
    const c = session.frame(5.2, false);

    expect(a.scale).not.toBe(b.scale);
    expect(b.scale).not.toBe(c.scale);
    expect(session.hasPosed).toBe(false);
    expect(motionCalls).toHaveLength(3);
  });

  it("measures t from the rig's own clock, not the scene's elapsed time", () => {
    const rig = new Rig();
    const session = CostumeSession.handoff(WAVY, rig, restPose(), { intensity: 0 });

    // A costume handed off late in the scene still starts its grow-in at t = 0.
    const frame = session.frame(500, false);
    expect(frame.scale).toBeLessThan(1e-2);
    const grown = session.frame(500.4, false);
    expect(grown.scale).toBeGreaterThan(frame.scale);
  });
});
