// Hand-built WebAssembly kernels for the audio tests — no network, no external
// toolchain. The denoise processor only needs the bare ABI from kernels.ts
// (memory + malloc/create/process, optionally the resampler exports), so a few
// hundred bytes of wasm stand in for DFN:
//
//   identityKernel()   process() copies in → out (a denoiser that does
//                      nothing). No resampler exports, so a non-48 kHz context
//                      exercises the passthrough fallback.
//   resamplerKernel()  the same, plus df_resampler_create/push. Each resampler
//                      state owns an echo ring (~0.74 s at 44.1 kHz):
//                        out[i] = 0.5·in[i] + 0.5·ring[i]
//                      So the input passes through immediately at full level
//                      (no charging), but after the input goes quiet the ring
//                      keeps echoing the OLD signal for ~0.74 s. Rebuilding the
//                      resampler state (what `reset` does) zeroes the ring, so
//                      the old input cannot leak into the new one — exactly the
//                      property the tests need to observe.

// ── wasm encoder (just enough for these kernels) ───────────────────────────

const uleb = (n: number): number[] => {
  const out: number[] = []
  let v = n >>> 0
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b) } while (v)
  return out
}
const sleb = (n: number): number[] => {
  const out: number[] = []
  let v = n | 0
  for (;;) {
    const b = v & 0x7f
    v >>= 7
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out }
    out.push(b | 0x80)
  }
}
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()]
const section = (id: number, payload: number[]): number[] => [id, ...uleb(payload.length), ...payload]

const I32 = 0x7f
const F32 = 0x7d
const funcType = (params: number[], results: number[]): number[] =>
  [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results]
const body = (locals: [number, number][], code: number[]): number[] =>
  [...uleb(locals.length), ...locals.flatMap(([n, t]) => [...uleb(n), t]), ...code, 0x0b]

// Instructions.
const localGet = (i: number) => [0x20, ...uleb(i)]
const localSet = (i: number) => [0x21, ...uleb(i)]
const globalGet = (i: number) => [0x23, ...uleb(i)]
const globalSet = (i: number) => [0x24, ...uleb(i)]
const i32Const = (n: number) => [0x41, ...sleb(n)]
const f32Const = (n: number): number[] => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, n, true)
  return [0x43, ...b]
}
const i32Load = [0x28, 0x02, 0x00]
const i32Store = [0x36, 0x02, 0x00]
const f32Load = [0x2a, 0x02, 0x00]
const f32Store = [0x38, 0x02, 0x00]
const i32Add = [0x6a]
const i32And = [0x71]
const i32Mul = [0x6c]
const i32LtU = [0x49]
const f32Add = [0x92]
const f32Mul = [0x94]
const block = [0x02, 0x40]              // blocktype void
const loop = [0x03, 0x40]
const br = (depth = 0) => [0x0c, ...uleb(depth)]
const brIf = (depth = 0) => [0x0d, ...uleb(depth)]
const eqz = [0x45]
const end = [0x0b]

const RING = 32768                  // echo ring length (floats)
const RING_MASK = RING - 1
const RS_BASE = 65536              // resampler arena base (above the malloc heap)
const RS_SLOT = 4 + RING * 4       // [writeIdx: i32][ring: f32 × RING]

// ptr + 4*idx
const addr = (ptrLocal: number, idxLocal: number): number[] => [
  ...localGet(ptrLocal), ...localGet(idxLocal), ...i32Const(4), ...i32Mul, ...i32Add,
]

// Zero [base, base+RS_SLOT) — a plain 4-byte store loop (bulk-memory ops aren't
// needed and their encoding is easy to get wrong by hand).
function zeroLoop(baseLocal: number, jLocal: number): number[] {
  return [
    ...i32Const(0), ...localSet(jLocal),
    ...block, ...loop,
      ...localGet(jLocal), ...i32Const(RS_SLOT), ...i32LtU, ...eqz, ...brIf(1),
      ...localGet(baseLocal), ...localGet(jLocal), ...i32Add, ...i32Const(0), ...i32Store,
      ...localGet(jLocal), ...i32Const(4), ...i32Add, ...localSet(jLocal),
      ...br(0),
    ...end, ...end,
  ]
}

function processBody(): number[] {
  // out[i] = in[i] for HOP=480 samples; return 1. locals: 3 = i
  return body([[1, I32]], [
    ...i32Const(0), ...localSet(3),
    ...block, ...loop,
      ...localGet(3), ...i32Const(480), ...i32LtU, ...eqz, ...brIf(1),
      ...addr(2, 3), ...addr(1, 3), ...f32Load, ...f32Store,
      ...localGet(3), ...i32Const(1), ...i32Add, ...localSet(3),
      ...br(0),
    ...end, ...end,
    ...i32Const(1),
  ])
}

function rsCreateBody(): number[] {
  // slot = (g2++) & 1 → base = RS_BASE + slot*RS_SLOT; zero it; return base.
  // locals: 0 = base, 1 = j
  return body([[1, I32], [1, I32]], [
    ...i32Const(RS_BASE),
    ...globalGet(2), ...i32Const(1), ...i32And, ...i32Const(RS_SLOT), ...i32Mul, ...i32Add,
    ...localSet(0),
    ...zeroLoop(0, 1),
    ...globalGet(2), ...i32Const(1), ...i32Add, ...globalSet(2),
    ...localGet(0),
  ])
}

function rsPushBody(): number[] {
  // rs_push(st, in, n, out, cap) → n.
  // locals: 5 = i, 6 = idx, 7 = x, 8 = echo (the OLD ring value)
  return body([[1, I32], [1, I32], [2, F32]], [
    ...localGet(0), ...i32Load, ...localSet(6),        // idx = st->writeIdx
    ...i32Const(0), ...localSet(5),
    ...block, ...loop,
      ...localGet(5), ...localGet(2), ...i32LtU, ...eqz, ...brIf(1),
      // x = in[i] ; echo = ring[idx] (read BEFORE overwriting)
      ...addr(1, 5), ...f32Load, ...localSet(7),
      ...localGet(0), ...i32Const(4), ...i32Add,
      ...localGet(6), ...i32Const(4), ...i32Mul, ...i32Add, ...f32Load, ...localSet(8),
      // ring[idx] = x
      ...localGet(0), ...i32Const(4), ...i32Add,
      ...localGet(6), ...i32Const(4), ...i32Mul, ...i32Add,
      ...localGet(7), ...f32Store,
      // out[i] = x + 0.5*echo   (the new input at full level; the old input's
      // echo tail added on top until a reset zeroes the ring)
      ...addr(3, 5),
      ...localGet(7),
      ...localGet(8), ...f32Const(0.5), ...f32Mul, ...f32Add,
      ...f32Store,
      // idx = (idx + 1) & RING_MASK
      ...localGet(6), ...i32Const(1), ...i32Add, ...i32Const(RING_MASK), ...i32And, ...localSet(6),
      ...localGet(5), ...i32Const(1), ...i32Add, ...localSet(5),
      ...br(0),
    ...end, ...end,
    ...localGet(0), ...localGet(6), ...i32Store,       // st->writeIdx = idx
    ...localGet(2),
  ])
}

function moduleBytes(withResampler: boolean): ArrayBuffer {
  // Types:
  //  0 malloc(i32)->i32    1 create()->i32    2 process(i32,i32,i32)->i32
  //  3 rs_create(i32,i32)->i32                4 rs_push(i32,i32,i32,i32,i32)->i32
  const types = [
    funcType([I32], [I32]),
    funcType([], [I32]),
    funcType([I32, I32, I32], [I32]),
    funcType([I32, I32], [I32]),
    funcType([I32, I32, I32, I32, I32], [I32]),
  ]

  // malloc: a bump heap in g0 (below RS_BASE).
  const malloc = body([[1, I32]], [
    ...globalGet(0), ...localSet(1),
    ...globalGet(0), ...localGet(0), ...i32Add, ...globalSet(0),
    ...localGet(1),
  ])
  const create = body([], [...i32Const(64)])

  const funcs = withResampler
    ? [malloc, create, processBody(), rsCreateBody(), rsPushBody()]
    : [malloc, create, processBody()]
  const typeIdx = withResampler ? [0, 1, 2, 3, 4] : [0, 1, 2]

  const exportsList: [string, number, number][] = [
    ['memory', 2, 0],
    ['df_lite_malloc', 0, 0],
    ['df_lite_create', 0, 1],
    ['df_lite_process', 0, 2],
  ]
  if (withResampler) exportsList.push(
    ['df_resampler_create', 0, 3],
    ['df_resampler_push', 0, 4],
  )
  const nameBytes = (n: string) => [...uleb(n.length), ...[...n].map((c) => c.charCodeAt(0))]
  const exportSec = vec(exportsList.map(([name, kind, idx]) => [...nameBytes(name), kind, ...uleb(idx)]))

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(3, vec(typeIdx.map((t) => uleb(t)))),
    ...section(5, vec([[...uleb(0x00), ...uleb(8)]])),                     // memory, min 8 pages (512 KB)
    ...section(6, vec([
      [I32, 0x01, ...i32Const(4096), ...end],                              // g0 malloc bump (mut i32)
      [I32, 0x01, ...i32Const(0), ...end],                                 // g1 reserved
      [I32, 0x01, ...i32Const(0), ...end],                                 // g2 resampler slot counter (mut i32)
    ])),
    ...section(7, exportSec),
    ...section(10, vec(funcs.map((b) => [...uleb(b.length), ...b]))),
  ]).buffer
}

/** Identity kernel (DFN ABI names, no resampler exports). */
export function identityKernel(): ArrayBuffer { return moduleBytes(false) }

/** Identity kernel plus echo-ring resampler exports. */
export function resamplerKernel(): ArrayBuffer { return moduleBytes(true) }

/** How long the resampler's ring echoes, in samples (for test timing). */
export const ECHO_RING = RING
