import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compositor } from './compositor'

class TestOffscreenCanvas {
  width: number
  height: number
  readonly ctx = {
    clearRect: vi.fn(),
    setTransform: vi.fn(),
  }

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(): CanvasRenderingContext2D {
    return this.ctx as unknown as CanvasRenderingContext2D
  }
}

function screenContext(): CanvasRenderingContext2D {
  return {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

afterEach(() => vi.unstubAllGlobals())

describe('Partial repaint boundaries', () => {
  it.each([1, 1.25, 1.5, 2, 3])('keeps damage alignment idempotent at DPR %s', dpr => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(100, 100, dpr)
    const aligned = compositor.getPaintRect({ x: 0.3, y: 2.1, width: 8.2, height: 6.3 })
    expect(aligned.x).toBeLessThanOrEqual(0.3)
    expect(aligned.y).toBeLessThanOrEqual(2.1)
    expect(aligned.x + aligned.width).toBeGreaterThanOrEqual(8.5)
    expect(aligned.y + aligned.height).toBeGreaterThanOrEqual(8.4 - 1e-10)
    expect(compositor.getPaintRect(aligned)).toEqual(aligned)
    compositor.clearLayer('main', aligned)
    expect(compositor.getContext('main').ctx.clearRect).toHaveBeenLastCalledWith(aligned.x, aligned.y, aligned.width, aligned.height)
  })

  it('clamps offscreen damage and skips empty rectangles', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(100, 80, 2)
    expect(compositor.getPaintRect({ x: -20, y: -10, width: 200, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 80 })
    expect(compositor.getPaintRect({ x: 0.2, y: 0.2, width: 0, height: 10 }).width).toBe(0)
  })


  it('clears the complete backing store and normalizes invalid damage', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(101, 81, 1.25)
    const full = compositor.getPaintRect()
    expect(full.width * 1.25).toBe(canvas.width)
    expect(full.height * 1.25).toBe(canvas.height)
    expect(compositor.getPaintRect({ x: NaN, y: 0, width: 10, height: 10 })).toEqual(full)
    compositor.clearLayer('main')
    expect(compositor.getContext('main').ctx.clearRect).toHaveBeenLastCalledWith(0, 0, full.width, full.height)
    compositor.composite()
    compositor.markDirtyRect('main', { x: -100, y: -100, width: 10, height: 10 })
    expect(compositor.isDirty('main')).toBe(false)
  })

  it('unions aligned damage and stays idempotent across repeated marking at fractional DPR', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.resize(100, 100, 1.5)
    const first = { x: 3.2, y: 3.2, width: 4, height: 4 }
    const second = { x: 10.1, y: 9.8, width: 3, height: 3 }
    compositor.markDirtyRect('main', first)
    compositor.markDirtyRect('main', second)

    const alignedFirst = compositor.getPaintRect(first)
    const alignedSecond = compositor.getPaintRect(second)
    const union = compositor.getPaintRect({
      x: Math.min(alignedFirst.x, alignedSecond.x),
      y: Math.min(alignedFirst.y, alignedSecond.y),
      width: Math.max(alignedFirst.x + alignedFirst.width, alignedSecond.x + alignedSecond.width)
        - Math.min(alignedFirst.x, alignedSecond.x),
      height: Math.max(alignedFirst.y + alignedFirst.height, alignedSecond.y + alignedSecond.height)
        - Math.min(alignedFirst.y, alignedSecond.y),
    })
    // The stored damage is aligned, so re-marking the same rect changes nothing.
    compositor.markDirtyRect('main', union)
    expect(compositor.getPaintRect(union)).toEqual(union)
  })

  it('takes registration order into effect immediately and forgets damage on removal', () => {
    vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas)
    const canvas = document.createElement('canvas')
    ;(canvas as any).getContext = vi.fn(() => screenContext())
    const compositor = new Compositor(canvas)
    compositor.registerLayer('inserted', 2)
    expect(compositor.getLayerOrder()).toEqual(['background', 'main', 'inserted', 'transient', 'overlay', 'tooltip'])
    compositor.markDirtyRect('inserted', { x: 1, y: 1, width: 2, height: 2 })
    expect(compositor.isDirty('inserted')).toBe(true)
    compositor.unregisterLayer('inserted')
    expect(compositor.getLayerOrder()).toEqual(['background', 'main', 'transient', 'overlay', 'tooltip'])
    expect(compositor.isDirty('inserted')).toBe(false)
    // Damage raised after removal cannot resurrect a dangling dirty entry.
    compositor.markDirty('inserted')
    compositor.markDirtyRect('inserted', { x: 1, y: 1, width: 2, height: 2 })
    expect(compositor.isDirty('inserted')).toBe(false)
    // A later composite has no knowledge of the removed layer or its damage.
    compositor.composite()
    expect(compositor.isDirty('inserted')).toBe(false)
  })
})
