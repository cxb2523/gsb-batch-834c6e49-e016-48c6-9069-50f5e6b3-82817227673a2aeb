import { describe, expect, it } from "vitest";
import type { Backend, Matrix, TextureSource } from "../src/backend.js";
import { copyAt, frameAt, type CopySpec } from "../src/copies.js";
import { Draw, type Frame } from "../src/draw.js";
import type { Layer } from "../src/layer.js";
import { Shader } from "../src/shader.js";
import { WebGL2Backend } from "../src/webgl2.js";

/**
 * A recording stand-in for WebGL2: every method is logged, `create*` returns a fresh tagged object and
 * `delete*` marks it deleted, so tests can check uploads, batching and that nothing leaks.
 */
function fakeGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const created: { kind: string; deleted: boolean }[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const canvas = {
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const shaderSources: string[] = [];
  const target: Record<string | symbol, unknown> = {
    canvas,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: (p: unknown) => (p === "MAX_TEXTURE_SIZE" ? 16384 : undefined),
    getUniformLocation: () => ({}),
    shaderSource: (_s: unknown, src: string) => shaderSources.push(src),
  };
  const gl = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key; // constants: their own name, readable in assertions
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (key.startsWith("create")) {
          const obj = { kind: key.slice(6), deleted: false };
          created.push(obj);
          return obj;
        }
        if (key.startsWith("delete")) (args[0] as { deleted: boolean }).deleted = true;
        return undefined;
      };
    },
  });
  const fire = (type: string) => listeners.get(type)?.({ preventDefault() {} } as Event);
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  return { gl: gl as unknown as WebGL2RenderingContext, calls, created, fire, count, shaderSources };
}

const image = (w = 16, h = 16) => ({ width: w, height: h }) as unknown as TextureSource;
/** Fixed-length atlas list, typed so indexing always yields a source (the count is a test constant). */
const atlases = (n: number, w = 16): TextureSource[] => Array.from({ length: n }, () => image(w, 16));
const framesOf = (imgs: TextureSource[]): Frame[] =>
  imgs.map((img, i) => ({ image: img, x: i % 2 ? 2 : 0, y: 0, w: 8, h: 6 }));

const at = <T,>(arr: T[], i: number): T => arr[i] as T;

/** Instanced draw call counts, in order. */
const instancedCounts = (calls: { name: string; args: unknown[] }[]) =>
  calls.filter((c) => c.name === "drawArraysInstanced").map((c) => c.args[3] as number);

/** Float32 buffer uploads of exactly `floats` entries. */
const floatUploads = (calls: { name: string; args: unknown[] }[], floats: number) =>
  calls
    .filter((c) => c.name === "bufferData")
    .map((c) => c.args[1])
    .filter((d): d is Float32Array => d instanceof Float32Array && d.length === floats);

/** Uint32 buffer uploads of exactly `n` entries. */
const uintUploads = (calls: { name: string; args: unknown[] }[], n: number) =>
  calls
    .filter((c) => c.name === "bufferData")
    .map((c) => c.args[1])
    .filter((d): d is Uint32Array => d instanceof Uint32Array && d.length === n);

/**
 * The static instance buffer a layer replay uploaded: a STATIC_DRAW upload of 14 floats × instances.
 * buildLayer uploads a raw ArrayBuffer, so wrap it in a Float32Array view.
 */
const layerBufferOf = (calls: { name: string; args: unknown[] }[], instances: number) => {
  const bytes = instances * 14 * 4;
  const match = calls
    .filter((c) => c.name === "bufferData" && c.args[2] === "STATIC_DRAW")
    .map((c) => c.args[1])
    .find((d): d is ArrayBuffer => d instanceof ArrayBuffer && d.byteLength === bytes);
  return new Float32Array(match as ArrayBuffer);
};

/** Routes a Draw's backend.copies through a spy while keeping every other method on the real backend. */
function captureCopies(backend: WebGL2Backend, sink: { spec?: CopySpec }): Backend {
  return new Proxy(backend, {
    get(t, k) {
      if (k === "copies") return (c: CopySpec) => {
        sink.spec = c;
      };
      return Reflect.get(t, k) as unknown;
    },
  }) as unknown as Backend;
}

describe("sprites(each) across atlases", () => {
  it("stays instanced and splits into a new batch only once eight texture units are bound", () => {
    const { gl, calls, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const imgs = atlases(10);
    const frames = framesOf(imgs);
    const n = 30;
    const pos = new Float32Array(n * 2);
    const index = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 2] = i * 3;
      pos[i * 2 + 1] = i;
      index[i] = i % frames.length;
    }
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index });
    draw.end();
    // Copies 0..7 bind eight distinct atlases; the 9th opens a new segment. Always instanced, never quads.
    const counts = instancedCounts(calls);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
    expect(counts[0]).toBe(8);
    for (const k of counts) expect(k).toBeLessThanOrEqual(n);
    expect(count("drawArraysInstanced")).toBe(counts.length);
    // No per-copy quad path: the only instanced primitive is TRIANGLE_STRIP with 4 vertices.
    expect(calls.every((c) => c.name !== "drawElements")).toBe(true);
    // One bindSampler per segment unit (upload-time binds on unit 0 don't count): never more than eight.
    const boundPerSegment: number[] = [];
    let open = 0;
    for (const c of calls) {
      if (c.name === "bindSampler") open++;
      if (c.name === "drawArraysInstanced") {
        boundPerSegment.push(open);
        open = 0;
      }
    }
    expect(boundPerSegment.length).toBe(counts.length);
    expect(Math.max(...boundPerSegment)).toBeLessThanOrEqual(8);
  });

  it("reuses a unit across the whole call when the working set fits, giving one batch for ten atlases", () => {
    const { gl, calls, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    // Ten atlases exist, but the copies only ever touch three of them: one batch, three units.
    const frames = framesOf(atlases(10));
    const n = 30;
    const pos = new Float32Array(n * 2);
    const index = new Uint8Array(n);
    for (let i = 0; i < n; i++) index[i] = i % 3;
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index });
    draw.end();
    expect(count("drawArraysInstanced")).toBe(1);
    expect(instancedCounts(calls)).toEqual([n]);
  });

  it("partitions copies without reordering: a new segment starts only at a copy boundary", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const frames = framesOf(atlases(9));
    const n = 18;
    const pos = new Float32Array(n * 2);
    const index = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 2] = i;
      pos[i * 2 + 1] = 0;
      index[i] = i % 9; // the 9th atlas first appears at copy 8
    }
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index });
    draw.end();
    // Copies 0..7 fill eight units; copy 8 opens a segment; copies 9..17 reuse units within it. Every copy is
    // drawn exactly once and the first segment is exactly the first eight copies (boundaries at copy edges).
    const counts = instancedCounts(calls);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
    expect(counts[0]).toBe(8);
    expect(counts.slice(1).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("uploads frame rects in copy order when one segment holds every atlas", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const two = atlases(2);
    const a = at(two, 0);
    const b = at(two, 1);
    const frames: Frame[] = [
      { image: a, x: 0, y: 0, w: 8, h: 6 },
      { image: b, x: 3, y: 2, w: 4, h: 3 },
    ];
    const n = 3;
    const pos = new Float32Array(n * 2);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: Uint8Array.of(1, 0, 1) });
    draw.end();
    const frameData = floatUploads(calls, n * 4).at(-1) as Float32Array;
    expect([...frameData]).toEqual([3, 2, 4, 3, 0, 0, 8, 6, 3, 2, 4, 3]);
    // The unit buffer is the final unit-attribute upload: a Float32Array whose upload length is exactly n
    // (the reused staging array may be larger, so match on the length argument, not the buffer's capacity).
    // Copy 0 uses atlas B (first seen -> unit 0), copy 1 atlas A (unit 1), copy 2 atlas B again (unit 0).
    const unitCall = calls
      .filter((c) => c.name === "bufferData" && c.args[1] instanceof Float32Array && c.args[4] === n)
      .at(-1) as { args: unknown[] };
    expect([...(unitCall.args[1] as Float32Array).subarray(0, n)]).toEqual([0, 1, 0]);
  });

  it("reuses a unit inside a segment when a copy's atlas returns", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const two = atlases(2);
    const a = at(two, 0);
    const b = at(two, 1);
    const frames = framesOf([a, b]);
    const n = 6;
    const pos = new Float32Array(n * 2);
    const index = Uint8Array.of(0, 1, 0, 1, 0, 1);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index });
    draw.end();
    expect(instancedCounts(calls)).toEqual([6]);
    const unitVals = floatUploads(calls, n).at(-1) as Float32Array;
    expect([...unitVals]).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("uploads one source-pixel frame rect and unit per copy", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const two = atlases(2);
    const a = at(two, 0);
    const b = at(two, 1);
    const frames: Frame[] = [
      { image: a, x: 0, y: 0, w: 8, h: 6 },
      { image: b, x: 2, y: 1, w: 4, h: 3 },
    ];
    const n = 4;
    const pos = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const index = Uint8Array.of(0, 1, 1, 0);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index });
    draw.end();
    const frameData = floatUploads(calls, n * 4).at(-1) as Float32Array;
    const unitVals = floatUploads(calls, n).at(-1) as Float32Array;
    expect([...frameData]).toEqual([0, 0, 8, 6, 2, 1, 4, 3, 2, 1, 4, 3, 0, 0, 8, 6]);
    expect([...unitVals]).toEqual([0, 1, 1, 0]);
    // UVs are derived in the shader from per-unit texinfo of 1/16.
    const info3fv = calls.filter((c) => c.name === "uniform3fv").at(-1)?.args[1] as Float32Array;
    expect(info3fv[0]).toBe(1 / 16);
    expect(info3fv[3]).toBe(1 / 16);
  });

  it("matches the one-quad-per-copy reference for colours and frames, with positions passed verbatim", () => {
    const be = new WebGL2Backend(fakeGL().gl);
    const sink: { spec?: CopySpec } = {};
    const draw = new Draw(captureCopies(be, sink), false);
    const two = atlases(2);
    const a = at(two, 0);
    const b = at(two, 1);
    const frames: Frame[] = [
      { image: a, x: 0, y: 0, w: 8, h: 6 },
      { image: b, x: 2, y: 1, w: 4, h: 3 },
    ];
    const n = 6;
    const pos = Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 4 + i : 3 + i * 2));
    const scale = Float32Array.of(1, 1.5, 0.5, 2, 0.75, 1.25);
    const rotation = Float32Array.of(0, 0.4, 0.8, 0.1, 1.2, 0.6);
    const colors = Uint32Array.of(0xffffffff, 0xff0000ff, 0x00ff0080, 0x8080ffff, 0xffffffff, 0x123456ff);
    const index = Uint8Array.of(0, 1, 0, 1, 0, 1);
    draw.begin("#000", 100, 50, 1);
    draw.push();
    draw.translate(7, -3);
    draw.rotate(0.2);
    draw.sprites(frames, pos, n, {}, { frame: index, scale, rotation, color: colors });
    draw.pop();
    draw.end();
    const spec = sink.spec as CopySpec;
    const q: Matrix = [1, 0, 0, 1, 0, 0];
    const reference = Array.from({ length: n }, (_, i) => {
      const f = frameAt(spec, i);
      return { f, color: copyAt(spec, i, q, f) };
    });
    // Run the real GPU path with the same scene.
    const real = fakeGL();
    const realDraw = new Draw(new WebGL2Backend(real.gl), false);
    realDraw.begin("#000", 100, 50, 1);
    realDraw.push();
    realDraw.translate(7, -3);
    realDraw.rotate(0.2);
    realDraw.sprites(frames, pos, n, {}, { frame: index, scale, rotation, color: colors });
    realDraw.pop();
    realDraw.end();
    const frameData = floatUploads(real.calls, n * 4).at(-1) as Float32Array;
    const colorData = uintUploads(real.calls, n).at(-1) as Uint32Array;
    const le = (rgba: number) => [(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255, rgba & 255];
    for (let i = 0; i < n; i++) {
      const f = reference[i]?.f as Frame;
      expect([...frameData.subarray(i * 4, i * 4 + 4)]).toEqual([f.x, f.y, f.w, f.h]);
      expect(le(colorData[i] as number)).toEqual(le(reference[i]?.color as number));
    }
    // Positions and per-copy scale/rotation go through verbatim; the shader runs the same algebra as sprite().
    const positions = floatUploads(real.calls, n * 2).at(-1) as Float32Array;
    expect([...positions]).toEqual([...pos]);
  });

  it("slices separate colour and scale arrays per segment without a source-offset bug", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const frames = framesOf(atlases(9));
    const n = 18;
    const pos = new Float32Array(n * 2);
    const index = new Uint8Array(n);
    const scale = Float32Array.from({ length: n }, (_, i) => 1 + i * 0.1);
    const rotation = Float32Array.from({ length: n }, (_, i) => i * 0.05);
    const color = Uint32Array.from({ length: n }, (_, i) => (i % 2 ? 0xff0000ff : 0x00ff00ff));
    for (let i = 0; i < n; i++) index[i] = i % 9;
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, pos, n, {}, { frame: index, scale, rotation, color });
    draw.end();
    // Every segment covers some copies; the colour subarrays must read from each segment's first copy, not
    // from a stale source offset. Walk the Uint32 colour uploads in order and check their first packed colour.
    const colorUploads = calls
      .filter((c) => c.name === "bufferData" && c.args[1] instanceof Uint32Array)
      .map((c) => c.args[1] as Uint32Array);
    // Segment sizes follow the in-order split; reconstruct them from instanced counts.
    const counts = instancedCounts(calls);
    let first = 0;
    expect(colorUploads).toHaveLength(counts.length);
    for (let s = 0; s < counts.length; s++) {
      expect(colorUploads[s]?.[0]).toBe(color[first]);
      first += counts[s] as number;
    }
    // All 18 copies were drawn exactly once.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
  });

  it("keeps interleaved records instanced, splitting between whole records", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const frames = framesOf(atlases(9));
    const n = 9;
    const stride = 6;
    const data = new Float32Array(n * stride);
    const bits = new Uint32Array(data.buffer);
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      data[o] = i;
      data[o + 1] = i * 2;
      data[o + 2] = 1 + (i % 2);
      data[o + 3] = i * 0.1;
      bits[o + 4] = 0x80ff40ff;
      data[o + 5] = i;
    }
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, data, n, {}, { stride, scale: 2, rotation: 3, color: 4, frame: 5 });
    draw.end();
    // Nine distinct atlases in nine copies: the 9th opens a second segment; both stay instanced.
    const counts = instancedCounts(calls);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
    expect(counts[0]).toBe(8);
    // The interleaved buffer is uploaded once whole; each segment reads its slice via an offset.
    expect(calls.filter((c) => c.name === "bufferData" && c.args[1] === data)).toHaveLength(1);
  });

  it("uploads u_texinfo for the single-image per-copy path so the shader can derive UVs", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image(24, 12);
    const pos = new Float32Array([1, 1, 2, 2]);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(img, pos, 2, {}, { scale: new Float32Array([1, 2]) });
    draw.end();
    const info = calls.filter((c) => c.name === "uniform3fv").map((c) => c.args[1] as Float32Array).at(-1) as Float32Array;
    expect(info[0]).toBe(Math.fround(1 / 24));
    expect(info[1]).toBe(Math.fround(1 / 12));
    expect(info[2]).toBe(0);
  });

  it("stays instanced under a custom shader whose fragment stage samples the eight-unit array", () => {
    const { gl, calls, shaderSources } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const frames = framesOf(atlases(2));
    const fx = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
    draw.begin("#000", 100, 50, 1);
    draw.withShader(fx, () =>
      draw.sprites(frames, new Float32Array([0, 0, 4, 4]), 2, {}, { frame: Uint8Array.of(0, 1) }),
    );
    draw.end();
    const eachFrag = shaderSources.find((s) => s.includes("u_tex[8]") && s.includes("vec4 effect"));
    expect(eachFrag).toBeDefined();
    expect(instancedCounts(calls)).toEqual([2]);
    expect(calls.some((c) => c.name === "uniform1iv")).toBe(true);
  });

  it("leaves no polluted texture units for the next draw: the later batch rebinds unit 0 itself", () => {
    const { gl, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    const draw = new Draw(be, false);
    const two = atlases(2);
    const a = at(two, 0);
    const b = at(two, 1);
    const frames = framesOf([a, b]);
    const after = image(12, 12);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(frames, new Float32Array([0, 0, 4, 4]), 2, {}, { frame: Uint8Array.of(0, 1) });
    draw.sprites(after, new Float32Array([1, 1]), 1);
    draw.end();
    const drawIdxs = calls.map((c, i) => (c.name === "drawArraysInstanced" ? i : -1)).filter((i) => i >= 0);
    const between = calls.slice(drawIdxs[0] as number, drawIdxs[1] as number);
    const rebind = between.filter((c) => c.name === "bindTexture" && c.args[0] === "TEXTURE_2D").at(-1);
    const texOf = (src: TextureSource) =>
      (be as unknown as { textures: Map<TextureSource, { tex: unknown }> }).textures.get(src)?.tex;
    expect(rebind?.args[1]).toBe(texOf(after));
    // Both draws are instanced; nothing fell back to individual quads.
    expect(instancedCounts(calls)).toEqual([2, 1]);
  });
});

describe("replay of layers with rotation, scale and skew", () => {
  it("replays a layer recorded under rotation and scale with instanced calls, never one by one", () => {
    const { gl, calls, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image();
    const layer = draw.record((d) => {
      d.push();
      d.translate(10, 0);
      d.rotate(0.5);
      d.scale(2);
      d.sprite(img, 4, 5, { rotation: 0.25 });
      d.pop();
      d.sprite(img, 1, 1);
    });
    draw.begin("#000", 100, 50, 1);
    draw.translate(3, 7);
    draw.replay(layer);
    draw.end();
    expect(count("drawArraysInstanced")).toBe(1);
    const data = layerBufferOf(calls, 2);
    // Baked quad instance: no SPRITE flag (16).
    expect(data[12] as number).toBeLessThan(16);
    // Plain sprite instance: SPRITE flag set.
    expect((data[14 + 12] as number) & 16).toBe(16);
  });

  it("bakes exactly the local matrix the one-by-one fallback would produce", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image(16, 16);
    const layer = draw.record((d) => {
      d.push();
      d.translate(10, 0);
      d.rotate(0.5);
      d.scale(2, 1.5);
      d.sprite(img, 4, 5, { rotation: 0.25, scaleX: 1.25, origin: [0.25, 0.75] });
      d.pop();
    });
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    draw.end();
    const item = layer.items[0] as Layer["items"][number];
    const o = item.o;
    const q: Matrix = [1, 0, 0, 1, 0, 0];
    placeAtRef(
      item.m,
      item.frame.w,
      item.frame.h,
      item.x,
      item.y,
      o.origin?.[0] ?? 0.5,
      o.origin?.[1] ?? 0.5,
      (o.scaleX ?? 1) * (o.flipX ? -1 : 1),
      (o.scaleY ?? 1) * (o.flipY ? -1 : 1),
      o.rotation ?? 0,
      q,
    );
    const data = layerBufferOf(calls, 1);
    // Baked quad instance layout is (a, c, e | b, d, f): compare against placeAt's [a, b, c, d, e, f].
    // The GPU buffer holds float32, so allow that rounding against the double-precision reference.
    const baked = [data[0], data[3], data[1], data[4], data[2], data[5]] as number[];
    for (let i = 0; i < 6; i++) expect(Math.abs((baked[i] as number) - (q[i] as number))).toBeLessThan(1e-5);
    // UVs stay in source pixels for the shader's texinfo conversion.
    expect([data[6], data[7], data[8], data[9]]).toEqual([0, 0, 16, 16]);
  });

  it("bakes skew, and sets SNAP only where the finished local matrix is axis aligned", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image();
    const layer = draw.record((d) => {
      d.push();
      d.transform(1, 0.2, 0.3, 1, 5, 6);
      d.sprite(img, 4, 5);
      d.pop();
      d.sprite(img, 2.4, 3.6);
    });
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    draw.end();
    const data = layerBufferOf(calls, 2);
    // Baked, skewed instance: unit 0, no SPRITE, no SNAP.
    expect(data[12] as number).toBe(0);
    // Identity-local sprite instance: SPRITE (16) + SNAP (64).
    expect(data[14 + 12] as number).toBe(80);
  });

  it("snaps a baked axis-aligned instance's translation to whole pixels", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image();
    const layer = draw.record((d) => {
      d.push();
      d.translate(2.4, 3.6);
      d.scale(2);
      d.sprite(img, 0, 0, { origin: [0, 0] });
      d.pop();
    });
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    draw.end();
    const data = layerBufferOf(calls, 1);
    expect(data[12] as number).toBe(64); // unit 0 + SNAP, no SPRITE
    expect(data[2]).toBe(2); // e rounded from 2.4
    expect(data[5]).toBe(4); // f rounded from 3.6
  });

  it("splits a rotated layer across nine atlases into instanced calls of at most eight units", () => {
    const { gl, calls, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const imgs = atlases(9);
    const layer = draw.record((d) => {
      imgs.forEach((img, i) => {
        d.push();
        d.rotate(i * 0.1);
        d.sprite(img, i, i);
        d.pop();
      });
    });
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    draw.end();
    // Nine distinct atlases: more than one instanced call, each at most eight units, all nine sprites covered.
    const counts = instancedCounts(calls);
    expect(count("drawArraysInstanced")).toBeGreaterThan(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(9);
  });

  it("rebuilds the GPU layer and recompiles a custom per-copy program after context loss", () => {
    const { gl, fire, count, shaderSources } = fakeGL();
    const be = new WebGL2Backend(gl);
    const draw = new Draw(be, false);
    const img = image();
    const layer = draw.record((d) => {
      d.push();
      d.rotate(0.5);
      d.sprite(img, 4, 5, { rotation: 0.25 });
      d.pop();
    });
    const fx = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    draw.withShader(fx, () => draw.sprites(img, new Float32Array([1, 1]), 1, {}, { scale: new Float32Array([1]) }));
    draw.end();
    const drawsBefore = count("drawArraysInstanced");
    const eachVertBefore = shaderSources.filter((s) => s.includes("u_texinfo[8]")).length;
    expect(drawsBefore).toBe(2);
    expect(eachVertBefore).toBeGreaterThan(0);
    fire("webglcontextlost");
    fire("webglcontextrestored");
    draw.begin("#000", 100, 50, 1);
    expect(() => draw.replay(layer)).not.toThrow();
    expect(() =>
      draw.withShader(fx, () => draw.sprites(img, new Float32Array([1, 1]), 1, {}, { scale: new Float32Array([1]) })),
    ).not.toThrow();
    draw.end();
    expect(count("drawArraysInstanced")).toBeGreaterThan(drawsBefore);
    expect(shaderSources.filter((s) => s.includes("u_texinfo[8]")).length).toBeGreaterThan(eachVertBefore);
  });

  it("does not pollute the texture units of a per-copy draw that immediately follows a replay", () => {
    const { gl, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    const draw = new Draw(be, false);
    const layerImg = image();
    const other = image(12, 12);
    const layer = draw.record((d) => {
      d.push();
      d.rotate(0.5);
      d.sprite(layerImg, 4, 5);
      d.pop();
    });
    draw.begin("#000", 100, 50, 1);
    draw.replay(layer);
    // A single-atlas per-copy draw right after the replay: unit 0 must be (re)bound to its own texture.
    draw.sprites(other, new Float32Array([1, 1]), 1, {}, { scale: new Float32Array([1]) });
    draw.end();
    const drawIdxs = calls.map((c, i) => (c.name === "drawArraysInstanced" ? i : -1)).filter((i) => i >= 0);
    expect(drawIdxs.length).toBe(2);
    const between = calls.slice(drawIdxs[0] as number, drawIdxs[1] as number);
    const rebind = between.filter((c) => c.name === "bindTexture" && c.args[0] === "TEXTURE_2D").at(-1);
    const texOf = (src: TextureSource) =>
      (be as unknown as { textures: Map<TextureSource, { tex: unknown }> }).textures.get(src)?.tex;
    expect(rebind?.args[1]).toBe(texOf(other));
    // Both stayed instanced: the replay did not leave the layer's texture bound on the copy program's unit 0.
    expect(instancedCounts(calls)).toEqual([1, 1]);
  });
});

/** Local copy of the placeAt algebra (copies.ts) for test expectations. */
function placeAtRef(
  m: Matrix,
  w: number,
  h: number,
  x: number,
  y: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
  r: number,
  out: Matrix,
): void {
  let a = sx;
  let b = 0;
  let c = 0;
  let d = sy;
  if (r) {
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    a = cos * sx;
    b = sin * sx;
    c = -sin * sy;
    d = cos * sy;
  }
  const px = -ox * w;
  const py = -oy * h;
  const lx = a * px + c * py + x;
  const ly = b * px + d * py + y;
  out[0] = (m[0] * a + m[2] * b) * w;
  out[1] = (m[1] * a + m[3] * b) * w;
  out[2] = (m[0] * c + m[2] * d) * h;
  out[3] = (m[1] * c + m[3] * d) * h;
  out[4] = m[0] * lx + m[2] * ly + m[4];
  out[5] = m[1] * lx + m[3] * ly + m[5];
}
