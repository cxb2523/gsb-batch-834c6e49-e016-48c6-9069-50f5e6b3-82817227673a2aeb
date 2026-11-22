import { describe, expect, it } from "vitest";
import type { Matrix } from "../src/backend.js";
import { placeAt } from "../src/copies.js";

/**
 * CPU simulations of the two new vertex shaders (EACH_VERT and LAYER_VERT), written line-for-line against the
 * GLSL. The reference is the finished quad matrix from placeAt() — exactly what the one-by-one draw.sprite
 * path submits. If the shader algebra reproduces every corner position and UV of that matrix for the same
 * inputs, the GPU path is pixel-identical to drawing the sprites individually.
 */

const fround = (x: number) => Math.fround(x);
const corner = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

/** EACH_VERT position + UV for one copy, mirroring the GLSL with float32 storage at the instance boundary. */
function eachVertex(input: {
  corner: readonly [number, number];
  pos: [number, number];
  perScale: number;
  perRot: number;
  frame: [number, number, number, number]; // x, y, w, h pixels
  u: {
    linear: Matrix;
    mt: [number, number];
    origin: [number, number];
    scale: [number, number];
    rot: number;
    snap: boolean;
    texinfo: [number, number, number];
  };
}): { p: [number, number]; uv: [number, number] } {
  const { corner: ac, pos, perScale, perRot, frame, u } = input;
  const r = u.rot + perRot;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const sx = fround(u.scale[0] * perScale);
  const sy = fround(u.scale[1] * perScale);
  const abx = fround(cs * sx);
  const aby = fround(sn * sx);
  const cdx = fround(-sn * sy);
  const cdy = fround(cs * sy);
  const size = [frame[2], frame[3]] as const;
  const ox = fround(-u.origin[0] * size[0]);
  const oy = fround(-u.origin[1] * size[1]);
  const lx = fround(fround(abx * ox) + fround(cdx * oy) + pos[0]);
  const ly = fround(fround(aby * ox) + fround(cdy * oy) + pos[1]);
  // M * l + mt
  const ex = fround(fround(u.linear[0] * lx + u.linear[2] * ly) + u.mt[0]);
  const ey = fround(fround(u.linear[1] * lx + u.linear[3] * ly) + u.mt[1]);
  let e: [number, number] = [ex, ey];
  if (u.snap && r === 0) e = [Math.floor(ex + 0.5), Math.floor(ey + 0.5)];
  const px = fround(fround(fround(u.linear[0] * abx + u.linear[2] * aby) * (size[0] * ac[0])) +
    fround(fround(u.linear[0] * cdx + u.linear[2] * cdy) * (size[1] * ac[1])) + e[0]);
  const py = fround(fround(fround(u.linear[1] * abx + u.linear[3] * aby) * (size[0] * ac[0])) +
    fround(fround(u.linear[1] * cdx + u.linear[3] * cdy) * (size[1] * ac[1])) + e[1]);
  const [iw, ih, v0] = u.texinfo;
  const uvx = fround((frame[0] + ac[0] * size[0]) * iw);
  const uvy = fround(v0 + (frame[1] + ac[1] * size[1]) * ih);
  return { p: [px, py], uv: [uvx, uvy] };
}

/** The CPU reference: position and UV of corner k from a finished quad matrix and a source rect. */
function quadReference(
  m: Matrix,
  rect: { iw: number; ih: number; v0: number; sx: number; sy: number; sw: number; sh: number },
  ac: readonly [number, number],
): { p: [number, number]; uv: [number, number] } {
  const px = m[0] * ac[0] + m[2] * ac[1] + m[4];
  const py = m[1] * ac[0] + m[3] * ac[1] + m[5];
  return {
    p: [fround(px), fround(py)],
    uv: [fround((rect.sx + ac[0] * rect.sw) * rect.iw), fround(rect.v0 + (rect.sy + ac[1] * rect.sh) * rect.ih)],
  };
}

describe("EACH_VERT shader math equals the per-quad reference", () => {
  const m: Matrix = [1.3, 0.4, -0.3, 1.1, 7.25, -3.5];
  const texinfo: [number, number, number] = [1 / 64, 1 / 48, 0];
  const frame = [5, 7, 12, 9] as const; // x, y, w, h
  const cases: {
    name: string;
    pos: [number, number];
    scale: [number, number];
    perScale: number;
    rot: number;
    perRot: number;
    origin: [number, number];
    snap: boolean;
  }[] = [
    { name: "identity, no rotation, snap", pos: [10, 20], scale: [1, 1], perScale: 1, rot: 0, perRot: 0, origin: [0.5, 0.5], snap: true },
    { name: "scaled, rotated, no snap", pos: [3.7, 8.2], scale: [1.5, 0.75], perScale: 1.25, rot: 0.6, perRot: 0.3, origin: [0.25, 0.75], snap: false },
    { name: "per-copy rotation only, snap on but r != 0", pos: [0, 0], scale: [1, 1], perScale: 1, rot: 0, perRot: 0.9, origin: [0, 0], snap: true },
    { name: "negative scale (flip), fractional pos, snap", pos: [11.4, 5.6], scale: [-1, 1], perScale: 2, rot: 0, perRot: 0, origin: [0.5, 0.5], snap: true },
    { name: "uniform rotation 1.1 plus per rotation", pos: [-4, 9], scale: [0.5, 2], perScale: 0.8, rot: 1.1, perRot: -0.4, origin: [1, 0], snap: false },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const totalSx = c.scale[0] * c.perScale;
      const totalSy = c.scale[1] * c.perScale;
      const totalR = c.rot + c.perRot;
      const q: Matrix = [1, 0, 0, 1, 0, 0];
      placeAt(m, frame[2], frame[3], c.pos[0], c.pos[1], c.origin[0], c.origin[1], totalSx, totalSy, totalR, q);
      // The GPU shader snaps the anchor in screen space after the transform (EACH_VERT: e = floor(e + .5)),
      // not the baked translation. Reproduce that anchor and rebuild the reference translation from it.
      if (c.snap && totalR === 0) {
        const lx = totalSx * (-c.origin[0] * frame[2]) + c.pos[0];
        const ly = totalSy * (-c.origin[1] * frame[3]) + c.pos[1];
        q[4] = Math.floor(fround(m[0] * lx + m[2] * ly + m[4]) + 0.5);
        q[5] = Math.floor(fround(m[1] * lx + m[3] * ly + m[5]) + 0.5);
      }
      for (const ac of corner) {
        const got = eachVertex({
          corner: ac,
          pos: c.pos,
          perScale: c.perScale,
          perRot: c.perRot,
          frame: [frame[0], frame[1], frame[2], frame[3]],
          u: {
            linear: m,
            mt: [m[4], m[5]],
            origin: c.origin,
            scale: c.scale,
            rot: c.rot,
            snap: c.snap,
            texinfo,
          },
        });
        const want = quadReference(q, { iw: texinfo[0], ih: texinfo[1], v0: 0, sx: frame[0], sy: frame[1], sw: frame[2], sh: frame[3] }, ac);
        // Float32 arithmetic differs only in the final ulps; positions must match to a tight epsilon.
        expect(Math.abs(got.p[0] - want.p[0])).toBeLessThan(1e-4);
        expect(Math.abs(got.p[1] - want.p[1])).toBeLessThan(1e-4);
        expect(got.uv[0]).toBeCloseTo(want.uv[0], 6);
        expect(got.uv[1]).toBeCloseTo(want.uv[1], 6);
      }
    });
  }
});

/** LAYER_VERT for a baked quad instance: it applies only the replay transform and rounds when SNAP is set. */
function layerBakedVertex(input: {
  corner: readonly [number, number];
  local: Matrix; // baked finished local quad matrix
  replay: Matrix;
  snap: boolean;
  frame: [number, number, number, number];
  texinfo: [number, number, number];
}): { p: [number, number]; uv: [number, number] } {
  const { corner: ac, local, replay, snap, frame, texinfo } = input;
  let lx = fround(local[0] * ac[0] + local[2] * ac[1] + local[4]);
  let ly = fround(local[1] * ac[0] + local[3] * ac[1] + local[5]);
  if (snap) {
    lx = Math.floor(lx + 0.5);
    ly = Math.floor(ly + 0.5);
  }
  const px = fround(fround(replay[0] * lx + replay[2] * ly) + replay[4]);
  const py = fround(fround(replay[1] * lx + replay[3] * ly) + replay[5]);
  const [iw, ih, v0] = texinfo;
  const uvx = fround((frame[0] + ac[0] * frame[2]) * iw);
  const uvy = fround(v0 + (frame[1] + ac[1] * frame[3]) * ih);
  return { p: [px, py], uv: [uvx, uvy] };
}

describe("LAYER_VERT baked-quad math equals replaying the sprite one by one", () => {
  const replay: Matrix = [1.2, 0.1, -0.15, 0.9, 4.5, 9.25];
  const texinfo: [number, number, number] = [1 / 32, 1 / 32, 0];
  const frame = [2, 3, 10, 8] as const;
  const locals: { m: Matrix; name: string; snap: boolean }[] = [
    {
      name: "rotated and scaled local transform",
      snap: false,
      m: (() => {
        const q: Matrix = [1, 0, 0, 1, 0, 0];
        placeAt([Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 10, 0], frame[2], frame[3], 4, 5, 0.5, 0.5, 2, 2, 0.25, q);
        return q;
      })(),
    },
    {
      name: "skewed local transform",
      snap: false,
      m: (() => {
        const q: Matrix = [1, 0, 0, 1, 0, 0];
        placeAt([1, 0.2, 0.3, 1, 5, 6], frame[2], frame[3], 4, 5, 0.5, 0.5, 1, 1, 0, q);
        return q;
      })(),
    },
    {
      name: "axis-aligned fractional local transform, snapped",
      snap: true,
      m: (() => {
        const q: Matrix = [1, 0, 0, 1, 0, 0];
        placeAt([2, 0, 0, 2, 2.4, 3.6], frame[2], frame[3], 0, 0, 0, 0, 1, 1, 0, q);
        q[4] = Math.round(q[4]);
        q[5] = Math.round(q[5]);
        return q;
      })(),
    },
  ];

  for (const { m, name, snap } of locals) {
    it(name, () => {
      // Reference: replay transform composed onto the baked local matrix (the one-by-one result).
      const ref: Matrix = [
        replay[0] * m[0] + replay[2] * m[1],
        replay[1] * m[0] + replay[3] * m[1],
        replay[0] * m[2] + replay[2] * m[3],
        replay[1] * m[2] + replay[3] * m[3],
        replay[0] * m[4] + replay[2] * m[5] + replay[4],
        replay[1] * m[4] + replay[3] * m[5] + replay[5],
      ];
      for (const ac of corner) {
        const got = layerBakedVertex({ corner: ac, local: m, replay, snap, frame: [frame[0], frame[1], frame[2], frame[3]], texinfo });
        const want = quadReference(ref, { iw: texinfo[0], ih: texinfo[1], v0: 0, sx: frame[0], sy: frame[1], sw: frame[2], sh: frame[3] }, ac);
        expect(Math.abs(got.p[0] - want.p[0])).toBeLessThan(1e-4);
        expect(Math.abs(got.p[1] - want.p[1])).toBeLessThan(1e-4);
        expect(got.uv[0]).toBeCloseTo(want.uv[0], 6);
        expect(got.uv[1]).toBeCloseTo(want.uv[1], 6);
      }
    });
  }
});
