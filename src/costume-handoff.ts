import { growIn, MOTIONS } from "./costume-motion.ts";
import { restPose, type Pose, type Rig } from "./costume-rig.ts";
import type { CostumeName } from "./costumes.ts";

/** The handful of the shared light the handoff needs to own. */
export type HandedLight = { intensity: number };

/**
 * Everything about one costume's time on stage, kept out of React so the
 * handoff rules can be tested without a renderer. A session starts at rest
 * every time: its rig's clock and springs are reset, the head pose returns to
 * rest, and the shared fire light is dark until the costume's own flame
 * recomputes it from its own size.
 */
export class CostumeSession {
  private posed = false;
  readonly name: CostumeName;
  private readonly rig: Rig;
  private readonly pose: Pose;

  constructor(name: CostumeName, rig: Rig, pose: Pose) {
    this.name = name;
    this.rig = rig;
    this.pose = pose;
  }

  /**
   * The atomic handoff for putting a costume on. Runs in the commit phase,
   * before the next frame, so nothing of the previous costume can survive into
   * the first frame of this one.
   */
  static handoff(name: CostumeName, rig: Rig, pose: Pose, light: HandedLight) {
    // New time base and springs: the motion replays from its stationary t = 0.
    rig.reset();
    // Head back to rest before the new motion writes its own tilt.
    Object.assign(pose, restPose());
    // Dark until this costume's flame measures itself; never the old flame's
    // intensity, whatever size either costume is.
    light.intensity = 0;
    return new CostumeSession(name, rig, pose);
  }

  /**
   * One frame of the costume. Under reduced motion the motion's t = 0 shape is
   * applied exactly once and never recomputed; otherwise the grow-in scale and
   * the motion's head pose are written together every frame.
   */
  frame(elapsed: number, reducedMotion: boolean): { scale: number; posed: boolean } {
    if (reducedMotion) {
      // Some parts (antennae, legs, a handle) only exist once their motion
      // builds them: pose them once, as at t = 0, and hold still. The head
      // pose itself stays at the rest pose the handoff set.
      if (this.posed) return { scale: 1, posed: true };
      this.posed = true;
      MOTIONS[this.name]?.(0, this.rig);
      return { scale: 1, posed: true };
    }

    this.posed = false;
    const t = this.rig.since(elapsed);
    const scale = Math.max(1e-3, growIn(t));
    // Scale and head pose are the same frame's values, written together.
    const head = MOTIONS[this.name]?.(t, this.rig);
    Object.assign(this.pose, restPose(), head);
    return { scale, posed: false };
  }

  /** Whether the one-off reduced-motion pose has already been applied. */
  get hasPosed() {
    return this.posed;
  }
}
