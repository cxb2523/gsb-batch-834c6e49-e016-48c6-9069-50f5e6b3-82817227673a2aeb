import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import {
  BackSide,
  Box3,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShapeGeometry,
  type Group as ThreeGroup,
  type Material,
  type Side,
} from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { costumeLoader, type CostumeName } from "./costumes.ts";
import { Flame, type FlameKind } from "./Flame.tsx";
import { CostumeSession } from "./costume-handoff.ts";
import { fireLight } from "./fire-light.ts";
import { Rig, restPose, type Pose } from "./costume-rig.ts";
import type { CostumeData } from "./costume-shapes.ts";

const loaded = new Map<CostumeName, CostumeData>();

// The logo draws sprites mirrored, with y pointing down, at 44 units to an ear.
const SPRITE_SCALE: [number, number, number] = [-8.85 / 44, -7.9 / 40, 1];
const SPRITE_LAYER = 0.004;
// Lil Spider's thread runs well out of frame, as if hung from the ceiling.
const THREAD_LENGTH = 120;
const threadGeometry = new CylinderGeometry(0.05, 0.05, THREAD_LENGTH, 6).translate(
  0,
  THREAD_LENGTH / 2,
  0,
);
const threadMaterial = new MeshStandardMaterial({
  color: "#b9bccb",
  roughness: 0.6,
});

const noRaycast = () => null;
const svgLoader = new SVGLoader();

const glowing = (part: string) => part === "embers" || part.startsWith("glow");
// Parts whose sprites only outline a fire; a live flame fills the outline instead.
const FLAMES: Record<string, FlameKind> = { flame: "candle", fire: "campfire" };
const GLOW_GAIN = 1.6;

function material(color: string, opacity = 1, side: Side = DoubleSide, part?: string) {
  if (part && glowing(part)) {
    const glow = new MeshBasicMaterial({
      color,
      side,
      transparent: opacity < 1,
      opacity,
      toneMapped: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    glow.color.multiplyScalar(GLOW_GAIN);
    glow.userData.gain = GLOW_GAIN;
    return glow;
  }
  return new MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.1,
    side,
    transparent: opacity < 1,
    opacity,
    // Painted-on details sit a hair above the shell; win the depth test there.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

type Part = { geometry: BufferGeometry; material: Material; part?: string };
type SpritePart = Part & { at: [number, number, number] };
type FlamePart = {
  part: string;
  kind: FlameKind;
  at: [number, number, number];
  box: Box3;
};

function build(data: CostumeData) {
  const parts: Part[] = [];
  const sprites: SpritePart[] = [];
  const flames: FlamePart[] = [];
  for (const group of data.groups) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(group.positions, 3));
    // Unindexed triangles get one normal per face: the same flat, faceted look as the logo.
    geometry.computeVertexNormals();
    if (group.back) {
      parts.push({
        geometry,
        material: material(group.color, group.opacity, FrontSide, group.part),
        part: group.part,
      });
      parts.push({
        geometry,
        material: material(group.back, group.opacity, BackSide, group.part),
        part: group.part,
      });
    } else {
      parts.push({
        geometry,
        material: material(group.color, group.opacity, DoubleSide, group.part),
        part: group.part,
      });
    }
  }
  for (const sprite of data.sprites) {
    const svg = svgLoader.parse(
      `<svg xmlns="http://www.w3.org/2000/svg"><path d="${sprite.path}"/></svg>`,
    );
    const shapes = svg.paths.flatMap((path) => SVGLoader.createShapes(path));
    const [x, y] = sprite.shift ?? [0, 0];
    const geometry = new ShapeGeometry(shapes)
      .scale(...SPRITE_SCALE)
      .translate(x, y, sprites.length * SPRITE_LAYER);
    const kind = sprite.part && FLAMES[sprite.part];
    if (kind) {
      geometry.computeBoundingBox();
      const flame = flames.find((f) => f.part === sprite.part);
      if (flame) flame.box.union(geometry.boundingBox!);
      else
        flames.push({
          part: sprite.part!,
          kind,
          at: sprite.at,
          box: geometry.boundingBox!,
        });
      geometry.dispose();
      continue;
    }
    sprites.push({
      geometry,
      material: material(sprite.color, sprite.opacity, DoubleSide, sprite.part),
      at: sprite.at,
      part: sprite.part,
    });
  }
  return { parts, sprites, flames };
}

const RELOADED_AT = "lilpix:reloaded-at";

/**
 * A costume's chunk failed to load, most often in a tab left open across a
 * deploy, whose old chunks are gone. Browsers remember a failed import, so
 * asking again can't help: reload to pick up the current build. The costume is
 * already saved, so the bot comes back wearing it. At most once a minute, so
 * an offline page doesn't reload forever.
 */
function reloadAfterFailedLoad(error: unknown) {
  console.error("Couldn't load the costume", error);
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT)) < 60_000) return;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // Storage blocked: no way to tell a reload loop apart, so don't risk one.
    return;
  }
  location.reload();
}

export function Costume({
  name,
  pose,
  reducedMotion,
}: {
  name: CostumeName;
  pose: RefObject<Pose>;
  reducedMotion: boolean;
}) {
  const current = loaded.get(name);
  const [, setLoads] = useState(0);

  useEffect(() => {
    if (loaded.has(name)) return;
    costumeLoader(name)().then((data) => {
      loaded.set(name, data);
      setLoads((n) => n + 1);
    }, reloadAfterFailedLoad);
  }, [name]);

  const built = useMemo(
    () => (current ? build(current) : { parts: [], sprites: [], flames: [] }),
    [current],
  );

  useEffect(
    () => () =>
      [...built.parts, ...built.sprites].forEach((part) => {
        part.geometry.dispose();
        part.material.dispose();
      }),
    [built],
  );

  // A fresh rig per costume: its clock and spring storage are born empty, and
  // the handoff below resets them again explicitly so nothing carries over.
  const rig = useMemo(() => {
    const rig = new Rig();
    for (const [part, info] of Object.entries(current?.parts ?? {})) rig.define(part, info);
    return rig;
  }, [current]);

  const root = useRef<ThreeGroup>(null);
  const session = useRef<CostumeSession | null>(null);

  // The atomic handoff. Layout effects run before the next frame is drawn and
  // before the newly mounted Flame measures this group, so the rig, pose,
  // light and scale all start the new costume from rest in the same commit.
  useLayoutEffect(() => {
    // Clear whatever the previous costume left before anything else this commit.
    Object.assign(pose.current, restPose());
    fireLight.intensity = 0;
    if (!current) {
      // The next costume is still loading: leave the stage empty and dark.
      session.current = null;
      return;
    }
    session.current = CostumeSession.handoff(name, rig, pose.current, fireLight);
    // Start collapsed: the first frame's growIn writes the matching tiny scale
    // before any flame can measure a full-size one.
    root.current?.scale.setScalar(1e-3);
  }, [current, name, rig, pose]);

  useFrame(({ clock }) => {
    const active = session.current;
    if (!current || !active || active.name !== name) return;
    const { scale } = active.frame(clock.elapsedTime, reducedMotion);
    root.current?.scale.setScalar(scale);
  });

  const meshes = (part?: string) => (
    <>
      {built.parts
        .filter((p) => p.part === part)
        .map((p, i) => (
          <mesh
            key={i}
            geometry={p.geometry}
            material={p.material}
            castShadow
            raycast={noRaycast}
          />
        ))}
      {built.sprites
        .filter((s) => s.part === part)
        .map((s, i) => (
          // Upright: turn about the vertical only, so flames and sprouts keep standing.
          <Billboard key={`sprite-${i}`} position={s.at} lockX lockZ>
            <mesh geometry={s.geometry} material={s.material} raycast={noRaycast} />
          </Billboard>
        ))}
      {built.flames
        .filter((f) => f.part === part)
        .map((f, i) => (
          <group key={`flame-${i}`} position={f.at}>
            <Flame kind={f.kind} box={f.box} seed={i} reducedMotion={reducedMotion} />
          </group>
        ))}
    </>
  );

  return (
    <group ref={root}>
      {meshes()}
      {Object.entries(current?.parts ?? {}).map(([part, info]) => (
        <group
          // Remount per costume, so no pose carries over to the next one.
          key={`${name}-${part}`}
          position={info.at}
          ref={(g) => rig.attach(part, g)}
        >
          {meshes(part)}
        </group>
      ))}
      {current?.threads?.map((at, i) => (
        <mesh
          key={`thread-${i}`}
          position={at}
          geometry={threadGeometry}
          material={threadMaterial}
          raycast={noRaycast}
        />
      ))}
    </group>
  );
}
