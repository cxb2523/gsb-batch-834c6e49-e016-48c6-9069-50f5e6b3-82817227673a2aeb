import { test, expect } from '@playwright/test'

// State-consistency tests for the WebGL comparison view: the effective media +
// mode must be the single source of truth for picture, metrics, color picker
// and export annotations across mode switches, A/B flips and segment jumps.
//
// All assets (images) are generated locally in the page — no network needed.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === 'http://127.0.0.1:4179' ? route.continue() : route.abort()
  })
})

test('comparisonState: media selection, flip mapping and metrics context invalidation', async ({ page }) => {
  await page.goto('/tests/fixtures/blank.html')
  const result = await page.evaluate(async () => {
    const cs = await import('/src/lib/webgl/comparisonState.ts')

    const clip = (id, mediaId, startTime, endTime) => ({
      id, mediaId, trackId: 'track', startTime, endTime, inPoint: 0, outPoint: endTime - startTime,
    })
    const tracks = [
      { id: 'track-a', name: 'A', type: 'a', acceptedTypes: [], muted: false, locked: false,
        clips: [clip('c1', 'm1', 0, 10), clip('c2', 'm2', 10, 20)] },
      { id: 'track-b', name: 'B', type: 'b', acceptedTypes: [], muted: false, locked: false,
        clips: [clip('c3', 'm3', 0, 20)] },
    ]
    const file = (id, url, type = 'image') => ({ id, name: id, type, url, status: 'ready' })
    const files = [
      file('m1', 'blob:seg-1'),
      file('m2', 'blob:seg-2'),
      file('m3', 'blob:b-1'),
      file('m4', '', 'image'),        // not ready (no URL) — must be skipped
      file('m5', 'blob:audio', 'audio'), // not image/video — must be skipped
    ]

    // Segment selection follows the playhead, falls back to first clip
    const at0 = cs.selectStableMedia(tracks, files, 0)
    const at15 = cs.selectStableMedia(tracks, files, 15)
    const at99 = cs.selectStableMedia(tracks, files, 99)

    // Flip mapping is the single place A/B assignment is decided
    const normal = cs.applyFlipAB(at0, false)
    const flipped = cs.applyFlipAB(at0, true)

    // Metrics context key invalidates on every relevant change
    const base = { mode: 'diff-absolute', flipAB: false, urlA: 'blob:seg-1', urlB: 'blob:b-1', threshold: 0.02, roi: null }
    const key = cs.buildMetricsContextKey(base)
    const variants = {
      mode: cs.buildMetricsContextKey({ ...base, mode: 'struct-ssim' }),
      flip: cs.buildMetricsContextKey({ ...base, flipAB: true }),
      segment: cs.buildMetricsContextKey({ ...base, urlA: 'blob:seg-2' }),
      threshold: cs.buildMetricsContextKey({ ...base, threshold: 0.5 }),
      roi: cs.buildMetricsContextKey({ ...base, roi: { x: 0, y: 0, width: 0.5, height: 0.5 } }),
    }

    return {
      at0a: at0.stableA?.url, at0b: at0.stableB?.url,
      at15a: at15.stableA?.url, at15b: at15.stableB?.url,
      at99a: at99.stableA?.url,
      normalA: normal.slotA?.url, normalB: normal.slotB?.url,
      flippedA: flipped.slotA?.url, flippedB: flipped.slotB?.url,
      key,
      variants,
      allVariantsDiffer: Object.values(variants).every(k => k !== key),
      currentOk: cs.isMetricsCurrent({ contextKey: key }, key),
      staleRejected: !cs.isMetricsCurrent({ contextKey: key }, variants.flip),
      missingKeyRejected: !cs.isMetricsCurrent({ ssim: 1 }, key),
      nullRejected: !cs.isMetricsCurrent(null, key),
    }
  })

  expect(result.at0a).toBe('blob:seg-1')
  expect(result.at0b).toBe('blob:b-1')
  // Playhead over the second clip → second segment's media is in effect
  expect(result.at15a).toBe('blob:seg-2')
  expect(result.at15b).toBe('blob:b-1')
  // Past all clips → fall back to first clip
  expect(result.at99a).toBe('blob:seg-1')
  // Flip swaps texture slots only
  expect(result.normalA).toBe('blob:seg-1')
  expect(result.normalB).toBe('blob:b-1')
  expect(result.flippedA).toBe('blob:b-1')
  expect(result.flippedB).toBe('blob:seg-1')
  // Any context change produces a new key; stale metrics are rejected
  expect(result.allVariantsDiffer).toBe(true)
  expect(result.currentOk).toBe(true)
  expect(result.staleRejected).toBe(true)
  expect(result.missingKeyRejected).toBe(true)
  expect(result.nullRejected).toBe(true)
})

test('renderer: texture slots are invalidated and released on segment switch', async ({ page }) => {
  await page.goto('/tests/fixtures/blank.html')
  const result = await page.evaluate(async () => {
    const { WebGLComparisonRenderer } = await import('/src/lib/webgl/WebGLComparisonRenderer.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    document.body.append(canvas)
    const renderer = new WebGLComparisonRenderer(canvas)
    const gl = renderer.gl // TS-private, accessible at runtime
    if (!gl) return { supported: false }

    renderer.setMode('diff-absolute')

    const img = document.createElement('canvas')
    img.width = 8
    img.height = 8
    const ictx = img.getContext('2d')

    const readCenterPixel = () => {
      renderer.render({ amplification: 1, threshold: 0, opacity: 1 })
      const px = new Uint8Array(4)
      gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return [...px]
    }

    // Segment 1: red source in slot A (slot B holds gray placeholder)
    ictx.fillStyle = 'rgb(255,0,0)'
    ictx.fillRect(0, 0, 8, 8)
    renderer.updateTexture('A', img, 'url-seg-1')
    const keyAfterUpload = renderer.getTextureSourceKey('A')
    const pixelSeg1 = readCenterPixel()

    // Segment switch: new source not ready → slot must be invalidated
    renderer.invalidateTexture('A')
    const keyAfterInvalidate = renderer.getTextureSourceKey('A')
    const pixelInvalidated = readCenterPixel()

    // Segment 2 becomes ready: green source under a new key
    ictx.fillStyle = 'rgb(0,255,0)'
    ictx.fillRect(0, 0, 8, 8)
    renderer.updateTexture('A', img, 'url-seg-2')
    const keyAfterReupload = renderer.getTextureSourceKey('A')
    const pixelSeg2 = readCenterPixel()

    renderer.dispose()
    return { supported: true, keyAfterUpload, keyAfterInvalidate, keyAfterReupload, pixelSeg1, pixelInvalidated, pixelSeg2 }
  })

  test.skip(!result.supported, 'WebGL not available in this browser')

  expect(result.keyAfterUpload).toBe('url-seg-1')
  expect(result.keyAfterInvalidate).toBeNull()
  expect(result.keyAfterReupload).toBe('url-seg-2')
  // |red - gray| → strong signal in every channel
  expect(result.pixelSeg1[0]).toBeGreaterThan(100)
  expect(result.pixelSeg1[1]).toBeGreaterThan(100)
  // After invalidation both slots hold the gray placeholder → no difference
  expect(result.pixelInvalidated[0]).toBeLessThan(30)
  expect(result.pixelInvalidated[1]).toBeLessThan(30)
  expect(result.pixelInvalidated[2]).toBeLessThan(30)
  // |green - gray| → strong green-channel signal
  expect(result.pixelSeg2[1]).toBeGreaterThan(100)
})

test('app: metrics, picker and export stay consistent across flip and segment jumps', async ({ page }) => {
  test.setTimeout(60000)
  await page.goto('/')

  // Expose the live store modules (same instances the app uses)
  await page.evaluate(async () => {
    const [projectStore, mediaStore, timelineStore, playbackStore, cs] = await Promise.all([
      import('/src/stores/projectStore.ts'),
      import('/src/stores/mediaStore.ts'),
      import('/src/stores/timelineStore.ts'),
      import('/src/stores/playbackStore.ts'),
      import('/src/lib/webgl/comparisonState.ts'),
    ])
    window.__test = {
      useProjectStore: projectStore.useProjectStore,
      useMediaStore: mediaStore.useMediaStore,
      useTimelineStore: timelineStore.useTimelineStore,
      usePlaybackStore: playbackStore.usePlaybackStore,
      cs,
    }
  })

  // Skip cleanly when WebGL is unavailable in this environment
  const webglOk = await page.evaluate(async () => {
    const { WebGLComparisonRenderer } = await import('/src/lib/webgl/WebGLComparisonRenderer.ts')
    return WebGLComparisonRenderer.isSupported()
  })
  test.skip(!webglOk, 'WebGL not available in this browser')

  // Load controlled image assets into the timeline:
  // track A: red segment (0-10s) then green segment (10-20s); track B: blue
  await page.evaluate(async () => {
    const { useMediaStore, useTimelineStore, useProjectStore } = window.__test
    const makeImageFile = async (r, g, b, name) => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      const ctx = c.getContext('2d')
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(0, 0, 64, 64)
      const blob = await new Promise(res => c.toBlob(res, 'image/png'))
      return new File([blob], name, { type: 'image/png' })
    }
    const mediaA1 = await useMediaStore.getState().addFile(await makeImageFile(255, 0, 0, 'seg-red.png'))
    const mediaA2 = await useMediaStore.getState().addFile(await makeImageFile(0, 255, 0, 'seg-green.png'))
    const mediaB = await useMediaStore.getState().addFile(await makeImageFile(0, 0, 255, 'blue.png'))
    useTimelineStore.getState().addClip('track-a', mediaA1.id, 0, 10)
    useTimelineStore.getState().addClip('track-a', mediaA2.id, 10, 10)
    useTimelineStore.getState().addClip('track-b', mediaB.id, 0, 20)
    useProjectStore.getState().setComparisonMode('webgl-compare')
    useProjectStore.getState().setWebGLComparisonMode('diff-absolute')
    useProjectStore.getState().setWebGLComparisonSettings({ amplification: 1 })
  })

  // Wait for the comparison canvas
  await page.waitForSelector('canvas.w-full', { timeout: 15000 })

  const readCanvasPixel = () => page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const canvas = document.querySelector('canvas.w-full')
    if (!canvas) return null
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    const tctx = tmp.getContext('2d')
    tctx.drawImage(canvas, 0, 0)
    return [...tctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data]
  })

  const waitForMetrics = () => page.waitForFunction(() => {
    const m = window.__test.useProjectStore.getState().webglAnalysisMetrics
    return !!(m && m.contextKey)
  }, null, { timeout: 15000 })

  const getMetricsKey = () => page.evaluate(() =>
    window.__test.useProjectStore.getState().webglAnalysisMetrics?.contextKey ?? null)

  const expectedContextKey = () => page.evaluate(() => {
    const { useProjectStore, useTimelineStore, useMediaStore, usePlaybackStore, cs } = window.__test
    const s = useProjectStore.getState().webglComparisonSettings
    const stable = cs.selectStableMedia(
      useTimelineStore.getState().tracks,
      useMediaStore.getState().files,
      usePlaybackStore.getState().currentTime
    )
    return cs.buildMetricsContextKey({
      mode: s.mode, flipAB: s.flipAB,
      urlA: stable.stableA?.url ?? null, urlB: stable.stableB?.url ?? null,
      threshold: s.threshold, roi: s.roi,
    })
  })

  // Enable metrics overlay and wait for the first computation
  await page.evaluate(() => window.__test.useProjectStore.getState().toggleWebGLMetricsOverlay())
  await waitForMetrics()
  const keyBeforeFlip = await getMetricsKey()
  expect(keyBeforeFlip).toBe(await expectedContextKey())

  // Picture before flip: |red - blue| = (255,0,255)
  const pixelBeforeFlip = await readCanvasPixel()
  expect(pixelBeforeFlip[0]).toBeGreaterThan(200)
  expect(pixelBeforeFlip[2]).toBeGreaterThan(200)

  // --- A/B flip: metrics from the pre-flip context must not survive ---
  await page.evaluate(() => window.__test.useProjectStore.getState().toggleWebGLFlipAB())
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  // Stale metrics are dropped immediately (or, if a fresh computation already
  // landed, it carries the NEW context key) — never the pre-flip key.
  const keyRightAfterFlip = await getMetricsKey()
  expect(keyRightAfterFlip).not.toBe(keyBeforeFlip)
  await waitForMetrics()
  const keyAfterFlip = await getMetricsKey()
  expect(keyAfterFlip).not.toBe(keyBeforeFlip)
  expect(keyAfterFlip).toBe(await expectedContextKey())

  // Picture after flip is symmetric for diff, but the picker must follow the flip
  await page.evaluate(() => {
    const { useProjectStore } = window.__test
    if (!useProjectStore.getState().webglComparisonSettings.showCursorInspector) {
      useProjectStore.getState().toggleWebGLCursorInspector()
    }
  })
  const canvas = page.locator('canvas.w-full').first()
  await canvas.hover({ position: { x: 40, y: 40 } })
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('div')].find(d => d.textContent?.includes('Pixel Inspector'))
    return el && /Source A:\s*0\s*0\s*255/.test(el.textContent)
  }, null, { timeout: 5000 }) // Flipped: Source A is track B media (blue)

  // Flip back: Source A must be track A media (red) — never the pre-flip mapping
  await page.evaluate(() => window.__test.useProjectStore.getState().toggleWebGLFlipAB())
  await canvas.hover({ position: { x: 120, y: 120 } })
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('div')].find(d => d.textContent?.includes('Pixel Inspector'))
    return el && /Source A:\s*255\s*0\s*0/.test(el.textContent)
  }, null, { timeout: 5000 })

  // --- Segment jump: old frames/metrics must be invalidated immediately ---
  await waitForMetrics()
  const keyBeforeSeek = await getMetricsKey()
  await page.evaluate(() => window.__test.usePlaybackStore.getState().seek(15))
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  // Previous segment's metrics are gone (or already replaced by new-context
  // ones) — the pre-seek key must never survive.
  const keyRightAfterSeek = await getMetricsKey()
  expect(keyRightAfterSeek).not.toBe(keyBeforeSeek)
  await waitForMetrics()
  const keyAfterSeek = await getMetricsKey()
  expect(keyAfterSeek).not.toBe(keyBeforeSeek)
  expect(keyAfterSeek).toBe(await expectedContextKey())

  // Picture now shows the green segment: |green - blue| = (0,255,255)
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas.w-full')
    if (!canvas) return false
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    const tctx = tmp.getContext('2d')
    tctx.drawImage(canvas, 0, 0)
    const px = tctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return px[0] < 80 && px[1] > 200 && px[2] > 200
  }, null, { timeout: 10000 })

  // --- Export: annotations must reflect the state at export time ---
  const download1Promise = page.waitForEvent('download')
  await page.locator('button[title="Save Screenshot (PNG)"]').click()
  const download1 = await download1Promise
  expect(download1.suggestedFilename()).toContain('diff-absolute')

  await page.evaluate(() => window.__test.useProjectStore.getState().setWebGLComparisonMode('struct-ssim'))
  const download2Promise = page.waitForEvent('download')
  await page.locator('button[title="Save Screenshot (PNG)"]').click()
  const download2 = await download2Promise
  expect(download2.suggestedFilename()).toContain('struct-ssim')
})
