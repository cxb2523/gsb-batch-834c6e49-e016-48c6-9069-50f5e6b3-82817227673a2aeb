import { describe, it, expect } from 'vitest'
import { identityKernel, resamplerKernel, ECHO_RING } from '../helpers/synth_kernel'

describe('synth kernel sanity', () => {
  it('identity kernel exports the DFN ABI and copies in → out', () => {
    const m = new WebAssembly.Module(identityKernel())
    const names = WebAssembly.Module.exports(m).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['memory', 'df_lite_malloc', 'df_lite_create', 'df_lite_process']))
    expect(names).not.toContain('df_resampler_create')

    const ex = new WebAssembly.Instance(m, {}).exports as unknown as Record<string, unknown> & { memory: WebAssembly.Memory }
    const malloc = ex.df_lite_malloc as (n: number) => number
    const process = ex.df_lite_process as (s: number, i: number, o: number) => number
    const create = ex.df_lite_create as () => number
    const inPtr = malloc(480 * 4), outPtr = malloc(480 * 4)
    const f = new Float32Array(ex.memory.buffer)
    for (let i = 0; i < 480; i++) f[(inPtr >> 2) + i] = (i % 10) / 10
    expect(process(create(), inPtr, outPtr)).toBe(1)
    for (let i = 0; i < 480; i++) expect(f[(outPtr >> 2) + i]).toBeCloseTo((i % 10) / 10)
  })

  it('resampler kernel: instant pass-through, then an old-input echo that a fresh state clears', () => {
    const m = new WebAssembly.Module(resamplerKernel())
    const names = WebAssembly.Module.exports(m).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['df_resampler_create', 'df_resampler_push']))

    const ex = new WebAssembly.Instance(m, {}).exports as unknown as Record<string, unknown> & { memory: WebAssembly.Memory }
    const malloc = ex.df_lite_malloc as (n: number) => number
    const rsCreate = ex.df_resampler_create as (a: number, b: number) => number
    const rsPush = ex.df_resampler_push as (s: number, i: number, n: number, o: number, c: number) => number
    const rs = rsCreate(44100, 48000)
    const inPtr = malloc(256 * 4), outPtr = malloc(4096 * 4)
    const f = () => new Float32Array(ex.memory.buffer)
    const n = 128
    const write = (v: number) => { for (let i = 0; i < n; i++) f()[(inPtr >> 2) + i] = v }
    const last = () => f()[(outPtr >> 2) + n - 1]

    // First burst of 1s: passed through immediately at full level (ring empty).
    write(1)
    expect(rsPush(rs, inPtr, n, outPtr, 4096)).toBe(n)
    expect(last()).toBeCloseTo(1, 3)

    // Fill the ring with 1s: the echo now adds on top → 1.5.
    for (let k = 0; k < Math.ceil(ECHO_RING / n) + 1; k++) rsPush(rs, inPtr, n, outPtr, 4096)
    expect(last()).toBeCloseTo(1.5, 2)

    // Then silence: the ring keeps echoing the old signal (0.5 × its level).
    write(0)
    for (let k = 0; k < 20; k++) rsPush(rs, inPtr, n, outPtr, 4096)
    expect(last()).toBeCloseTo(0.5, 2)      // old-input echo, NOT silence

    // A fresh state fed silence is silent immediately — this is what reset does.
    const rs2 = rsCreate(44100, 48000)
    for (let k = 0; k < 20; k++) rsPush(rs2, inPtr, n, outPtr, 4096)
    expect(last()).toBe(0)
  })
})
