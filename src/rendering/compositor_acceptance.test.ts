import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compositor } from './compositor'

// In-memory, pixel-accurate canvas harness. jsdom ships without a canvas backend
// (HTMLCanvasElement.getContext is not implemented), so partial-vs-full repaint
// equivalence is verified against this deterministic software rasterizer instead
// of a native dependency. It models the Canvas2D state the compositor relies on:
// DPR transform, save/restore clip stack, clearRect, fillRect and drawImage.

type RGBA = readonly [number, number, number, number]
const TRANSPARENT: RGBA = [0, 0, 0, 0]

function parseColor(value: string): RGBA {
  const match = /^rgba?\(([^)]+)\)$/.exec(value.trim())
  if (match) {
    const parts = match[1]!.split(',').map(part => Number(part.trim()))
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]
  }
  if (value[0] === '#') {
    const hex = value.slice(1)
    const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ]
  }
  throw new Error(`Unsupported test color: ${value}`)
}

function blend(destination: RGBA, source: RGBA): RGBA {
  const [sr, sg, sb, sa] = source
  if (sa === 0) return destination
  if (sa === 1) return source
  const [dr, dg, db, da] = destination
  const outAlpha = sa + da * (1 - sa)
  if (outAlpha === 0) return TRANSPARENT
  const channel = (s: number, d: number) =>
    Math.round((s * sa + d * da * (1 - sa)) / outAlpha)
  return [channel(sr, dr), channel(sg, dg), channel(sb, db), outAlpha]
}

interface ClipRect { x: number; y: number; right: number; bottom: number }

class MemoryContext {
  fillStyle: string = '#000000'
  strokeStyle: string = '#000000'
  lineWidth = 1
  font = '10px sans-serif'
  textAlign: CanvasTextAlign = 'left'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  private transform = { a: 1, d: 1, e: 0, f: 0 }
  private clipStack: (ClipRect | null)[] = []
  private currentClip: ClipRect | null = null
  private pendingRect: ClipRect | null = null
  readonly clearRectCalls: ClipRect[] = []

  constructor(readonly canvas: MemoryCanvas) {}

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    expect([b, c]).toEqual([0, 0])
    this.transform = { a, d, e, f }
  }

  getTransform(): DOMMatrix {
    const { a, d, e, f } = this.transform
    return { a, b: 0, c: 0, d, e, f } as DOMMatrix
  }

  save(): void {
    this.clipStack.push(this.currentClip ? { ...this.currentClip } : null)
  }

  restore(): void {
    const previous = this.clipStack.pop() ?? null
    this.currentClip = previous ? { ...previous } : null
  }

  beginPath(): void {
    this.pendingRect = null
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.pendingRect = this.toDeviceRect(x, y, width, height)
  }

  clip(): void {
    const incoming = this.pendingRect ?? {
      x: 0,
      y: 0,
      right: this.canvas.width,
      bottom: this.canvas.height,
    }
    this.currentClip = this.currentClip
      ? intersectClip(this.currentClip, incoming)
      : { ...incoming }
    this.pendingRect = null
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    const rect = this.clampedDeviceRect(x, y, width, height)
    if (!rect) return
    this.clearRectCalls.push({ ...rect })
    for (let py = rect.y; py < rect.bottom; py++) {
      for (let px = rect.x; px < rect.right; px++) {
        this.canvas.pixels[py * this.canvas.width + px] = TRANSPARENT
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const rect = this.clampedDeviceRect(x, y, width, height)
    if (!rect) return
    const source = parseColor(this.fillStyle)
    for (let py = rect.y; py < rect.bottom; py++) {
      for (let px = rect.x; px < rect.right; px++) {
        const index = py * this.canvas.width + px
        this.canvas.pixels[index] = blend(this.canvas.pixels[index]!, source)
      }
    }
  }

  drawImage(image: MemoryCanvas, dx: number, dy: number): void {
    const startX = Math.max(0, Math.floor(dx))
    const startY = Math.max(0, Math.floor(dy))
    for (let py = startY; py < Math.min(this.canvas.height, dy + image.height); py++) {
      for (let px = startX; px < Math.min(this.canvas.width, dx + image.width); px++) {
        if (this.currentClip && !insideClip(this.currentClip, px, py)) continue
        const sourcePixel = image.pixels[(py - startY) * image.width + (px - startX)]!
        if (sourcePixel[3] === 0) continue
        const index = py * this.canvas.width + px
        this.canvas.pixels[index] = blend(this.canvas.pixels[index]!, sourcePixel)
      }
    }
  }

  private toDeviceRect(x: number, y: number, width: number, height: number): ClipRect {
    const { a, d, e, f } = this.transform
    return {
      x: Math.floor(x * a + e),
      y: Math.floor(y * d + f),
      right: Math.ceil((x + width) * a + e),
      bottom: Math.ceil((y + height) * d + f),
    }
  }

  private clampedDeviceRect(x: number, y: number, width: number, height: number): ClipRect | null {
    const rect = this.toDeviceRect(x, y, width, height)
    const bounded: ClipRect = {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      right: Math.min(this.canvas.width, rect.right),
      bottom: Math.min(this.canvas.height, rect.bottom),
    }
    const clipped = this.currentClip ? intersectClip(this.currentClip, bounded) : bounded
    if (clipped.right <= clipped.x || clipped.bottom <= clipped.y) return null
    return clipped
  }
}

function insideClip(clip: ClipRect, x: number, y: number): boolean {
  return x >= clip.x && x < clip.right && y >= clip.y && y < clip.bottom
}

function intersectClip(a: ClipRect, b: ClipRect): ClipRect {
  return {
    x: Math.max(a.x, b.x),
    y: Math.max(a.y, b.y),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

class MemoryCanvas {
  width: number
  height: number
  readonly pixels: RGBA[]
  readonly style: Record<string, string> = {}
  private context: MemoryContext | null = null
  ownerDocument = { createElement: () => new MemoryCanvas(1, 1) }

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width))
    this.height = Math.max(1, Math.round(height))
    this.pixels = Array.from({ length: this.width * this.height }, () => [...TRANSPARENT] as RGBA)
  }

  getContext(): CanvasRenderingContext2D {
    if (!this.context) this.context = new MemoryContext(this)
    return this.context as unknown as CanvasRenderingContext2D
  }
}

function screenSnapshot(compositor: Compositor): string {
  const screen = compositor.screenCanvas as unknown as MemoryCanvas
  return screen.pixels.map(pixel => pixel.join(',')).join('|')
}

function screenContext(compositor: Compositor): MemoryContext {
  return compositor.screenCanvas.getContext('2d') as unknown as MemoryContext
}

function layerContext(compositor: Compositor, layer: string): MemoryContext {
  return compositor.getContext(layer).ctx as unknown as MemoryContext
}

function createCompositor(cssWidth: number, cssHeight: number, dpr: number): Compositor {
  vi.stubGlobal('OffscreenCanvas', MemoryCanvas)
  const screen = new MemoryCanvas(cssWidth * dpr, cssHeight * dpr)
  const compositor = new Compositor(screen as unknown as HTMLCanvasElement, dpr)
  compositor.resize(cssWidth, cssHeight, dpr)
  return compositor
}

afterEach(() => vi.unstubAllGlobals())

describe('Compositor acceptance: partial repaint equals full repaint', () => {
  it('reproduces a full composite when two layers carry overlapping partial damage', () => {
    const compositor = createCompositor(20, 12, 1)
    const red = 'rgba(200,30,30,1)'
    const blue = 'rgba(30,30,200,1)'

    const paintLayers = () => {
      const main = layerContext(compositor, 'main')
      main.fillStyle = red
      main.fillRect(2, 2, 8, 6)
      const overlay = layerContext(compositor, 'overlay')
      overlay.fillStyle = blue
      overlay.fillRect(6, 4, 8, 6)
    }

    // Baseline: full layer paint followed by a full-screen composite.
    paintLayers()
    compositor.markDirty('main')
    compositor.markDirty('overlay')
    compositor.composite()
    const fullPixels = screenSnapshot(compositor)

    // Rebuild the layer canvases, then repaint only partially overlapping damage.
    compositor.resize(20, 12, 1)
    paintLayers()
    const damages: Array<[string, { x: number; y: number; width: number; height: number }, string]> = [
      ['main', { x: 3, y: 3, width: 5, height: 4 }, red],
      ['overlay', { x: 7, y: 5, width: 5, height: 4 }, blue],
    ]
    for (const [layer, damage, color] of damages) {
      const ctx = layerContext(compositor, layer)
      const paintRect = compositor.getPaintRect(damage)
      compositor.clearLayer(layer, paintRect)
      ctx.fillStyle = color
      ctx.fillRect(paintRect.x, paintRect.y, paintRect.width, paintRect.height)
      compositor.markDirtyRect(layer, paintRect)
    }
    compositor.composite()

    expect(screenSnapshot(compositor)).toBe(fullPixels)
    expect(compositor.isDirty('main')).toBe(false)
    expect(compositor.isDirty('overlay')).toBe(false)
  })

  it('keeps two consecutive partial repaints at 1.5 DPR drift-free', () => {
    const compositor = createCompositor(20, 12, 1.5)
    expect((compositor.screenCanvas as unknown as MemoryCanvas).width).toBe(30)
    expect((compositor.screenCanvas as unknown as MemoryCanvas).height).toBe(18)

    const green = 'rgba(20,180,20,1)'
    const ctx = layerContext(compositor, 'main')
    ctx.fillStyle = green
    ctx.fillRect(2, 2, 8, 6)
    compositor.markDirty('main')
    compositor.composite()
    const baseline = screenSnapshot(compositor)

    const damage = { x: 4, y: 4, width: 4, height: 2 }
    const aligned = compositor.getPaintRect(damage)
    // Aligned CSS coordinates round-trip through the fractional DPR without drift.
    expect(compositor.getPaintRect(aligned)).toEqual(aligned)
    expect(aligned).toEqual({ x: 4, y: 4, width: 4, height: 2 })

    const screen = screenContext(compositor)
    screen.clearRectCalls.length = 0
    const repaint = () => {
      const paintRect = compositor.getPaintRect(damage)
      compositor.clearLayer('main', paintRect)
      ctx.fillStyle = green
      ctx.fillRect(paintRect.x, paintRect.y, paintRect.width, paintRect.height)
      compositor.markDirtyRect('main', paintRect)
      compositor.composite()
    }

    repaint()
    expect(screenSnapshot(compositor)).toBe(baseline)
    repaint()
    expect(screenSnapshot(compositor)).toBe(baseline)

    // Both partial composites cleared the exact same physical pixel rectangle.
    const dpr = 1.5
    const physicalClear = {
      x: aligned.x * dpr,
      y: aligned.y * dpr,
      right: (aligned.x + aligned.width) * dpr,
      bottom: (aligned.y + aligned.height) * dpr,
    }
    expect(screen.clearRectCalls).toEqual([physicalClear, physicalClear])
  })

  it('drops every trace of an unregistered layer, including its pending dirty region', () => {
    const compositor = createCompositor(20, 12, 1)
    compositor.registerLayer('custom', 1)
    expect(compositor.getLayerOrder())
      .toEqual(['background', 'custom', 'main', 'transient', 'overlay', 'tooltip'])

    layerContext(compositor, 'main').fillRect(0, 0, 4, 4)
    layerContext(compositor, 'custom').fillRect(6, 6, 4, 4)
    compositor.markDirtyRect('main', { x: 0, y: 0, width: 4, height: 4 })
    compositor.markDirtyRect('custom', { x: 6, y: 6, width: 4, height: 4 })
    expect(compositor.isDirty('custom')).toBe(true)

    compositor.unregisterLayer('custom')
    expect(compositor.getLayerOrder()).not.toContain('custom')
    expect(compositor.isDirty('custom')).toBe(false)

    // Instrument the screen rasterizer to count which layer canvases are composited.
    const screen = screenContext(compositor)
    const composited: MemoryCanvas[] = []
    const originalDrawImage = screen.drawImage.bind(screen)
    screen.drawImage = ((image: MemoryCanvas, dx: number, dy: number) => {
      composited.push(image)
      originalDrawImage(image, dx, dy)
    }) as typeof screen.drawImage

    compositor.composite()
    expect(composited).toHaveLength(5)
    expect(compositor.getLayerOrder()).toEqual(['background', 'main', 'transient', 'overlay', 'tooltip'])
    expect(compositor.isDirty('main')).toBe(false)

    // The removed layer's pixels were never copied onto the screen.
    const backing = compositor.screenCanvas as unknown as MemoryCanvas
    expect(backing.pixels[(6 + 1) * backing.width + (6 + 1)]).toEqual(TRANSPARENT)
  })

  it('rebuilds layer canvases at the new DPR on resize and starts from clean damage', () => {
    const compositor = createCompositor(20, 12, 1)
    compositor.markDirtyRect('main', { x: 1, y: 1, width: 2, height: 2 })
    expect(compositor.isDirty('main')).toBe(true)

    compositor.resize(20, 12, 1.5)
    const backing = (layerContext(compositor, 'main') as unknown as { canvas: MemoryCanvas }).canvas
    expect(backing.width).toBe(30)
    expect(backing.height).toBe(18)
    // Resize marks each layer fully dirty; a composite consumes all damage.
    expect(compositor.isDirty('main')).toBe(true)
    compositor.composite()
    for (const layer of compositor.getLayerOrder()) {
      expect(compositor.isDirty(layer)).toBe(false)
    }
  })
})
