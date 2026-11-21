/**
 * WebGL Comparison Component
 * GPU-accelerated comparison with 26 analysis modes
 * WEBGL-001: Quantitative Metrics Overlay
 * WEBGL-002: Color Legend / Scale Bar
 * WEBGL-007: Zoom and Pan
 * WEBGL-008: A/B Flip Toggle
 */

import { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useMediaStore } from '../../stores/mediaStore'
import { useTimelineStore } from '../../stores/timelineStore'
import { usePlaybackStore } from '../../stores/playbackStore'
import { WebGLComparisonRenderer } from '../../lib/webgl/WebGLComparisonRenderer'
import { getComparisonModeInfo } from '../../lib/webgl/comparison-shaders'
import { useOptimizedClipSync } from '../../hooks/useOptimizedVideoSync'
import { computeMetricsFromWebGLCanvas } from '../../lib/webgl/metricsComputation'
import {
  selectStableMedia,
  applyFlipAB,
  buildMetricsContextKey,
  isMetricsCurrent,
  elementMatchesUrl
} from '../../lib/webgl/comparisonState'
import { BarChart3, Ruler, FlipHorizontal, ZoomIn, ZoomOut, RotateCcw, Crosshair, Camera, Copy, Scan, X, LineChart, FileText, Palette, AlertTriangle, Activity, Image, Video } from 'lucide-react'
import type { MediaFile, ROIRect } from '../../types'
import { TemporalDiffGraph } from './TemporalDiffGraph'
import { WebGLSplitView, SplitViewToggle } from './WebGLSplitView'
import { WebGLPresetsPanel, PresetsToggle } from './WebGLPresetsPanel'
import { BatchComparison, BatchComparisonToggle } from './BatchComparison'
import { CustomShaderEditor, ShaderEditorToggle } from './CustomShaderEditor'
import { generatePDFReport, downloadBlob, captureCanvasScreenshot } from '../../lib/screenshotExport'
import { HistogramPanel, ColorWheelPanel, GamutWarningOverlay } from '../scopes'

export function WebGLComparison() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<WebGLComparisonRenderer | null>(null)
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const imgARef = useRef<HTMLImageElement>(null)
  const imgBRef = useRef<HTMLImageElement>(null)
  const animationRef = useRef<number>(0)
  const metricsTimerRef = useRef<number>(0)
  const lastMetricsTimeRef = useRef<number>(0)
  // Bumped whenever the metrics context changes — queued metrics computations
  // check this generation and refuse to write stale results.
  const metricsGenerationRef = useRef(0)

  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 })
  const [screenMousePos, setScreenMousePos] = useState({ x: 0, y: 0 })
  const [isSupported, setIsSupported] = useState(true)
  const [imagesLoaded, setImagesLoaded] = useState({ a: false, b: false })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [cursorPixelInfo, setCursorPixelInfo] = useState<{
    a: { r: number; g: number; b: number } | null;
    b: { r: number; g: number; b: number } | null;
  }>({ a: null, b: null })

  // WEBGL-004: ROI drawing state
  const [isDrawingROI, setIsDrawingROI] = useState(false)
  const [roiStart, setROIStart] = useState({ x: 0, y: 0 })
  const [tempROI, setTempROI] = useState<ROIRect | null>(null)

  // WEBGL-009: Temporal diff graph visibility (only for videos)
  const [showTemporalGraph, setShowTemporalGraph] = useState(false)

  // WEBGL-011: Split view visibility
  const [showSplitView, setShowSplitView] = useState(false)

  // WEBGL-015: Presets panel visibility
  const [showPresetsPanel, setShowPresetsPanel] = useState(false)

  // WEBGL-013: Batch comparison visibility
  const [showBatchComparison, setShowBatchComparison] = useState(false)

  // WEBGL-014: Custom shader editor visibility
  const [showShaderEditor, setShowShaderEditor] = useState(false)

  // SCOPE-008: Histogram panel visibility
  const [showHistogramPanel, setShowHistogramPanel] = useState(false)

  // SCOPE-009: Color wheel panel visibility
  const [showColorWheelPanel, setShowColorWheelPanel] = useState(false)

  // SCOPE-010: Gamut warning overlay visibility
  const [showGamutWarning, setShowGamutWarning] = useState(false)

  const {
    webglComparisonSettings,
    webglAnalysisMetrics,
    setWebGLAnalysisMetrics,
    toggleWebGLMetricsOverlay,
    toggleWebGLScaleBar,
    toggleWebGLFlipAB,
    toggleWebGLCursorInspector,
    setWebGLZoom,
    setWebGLPan,
    resetWebGLZoom,
    setROI,
    clearROI,
    toggleROIControls
  } = useProjectStore()
  const { addFile } = useMediaStore()
  const { tracks, addClip } = useTimelineStore()
  // Subscribe to files to trigger re-renders when files are added/updated
  const mediaFiles = useMediaStore(state => state.files)

  // File upload refs for empty state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentUploadTarget = useRef<{ track: 'a' | 'b' } | null>(null)
  const { currentTime } = usePlaybackStore()

  // Get active media from tracks
  const trackA = tracks.find(t => t.type === 'a')
  const trackB = tracks.find(t => t.type === 'b')

  // Get first clip for display
  const firstClipA = trackA?.clips[0] || null
  const firstClipB = trackB?.clips[0] || null

  // Find clip that contains current time for proper sync
  const activeClipA = useMemo(() => {
    if (!trackA) return null
    return trackA.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime) || null
  }, [trackA, currentTime])

  const activeClipB = useMemo(() => {
    if (!trackB) return null
    return trackB.clips.find(c => currentTime >= c.startTime && currentTime < c.endTime) || null
  }, [trackB, currentTime])

  // Get media files - use active clip (clip at current time), fallback to first clip.
  // This derivation is the single source of truth for "which media is in
  // effect" — picture, metrics, picker and export all derive from it (see
  // lib/webgl/comparisonState).
  const { stableA: stableMediaA, stableB: stableMediaB } = useMemo(
    () => selectStableMedia(tracks, mediaFiles, currentTime),
    [tracks, mediaFiles, currentTime]
  )

  // WEBGL-008: A/B Flip - only affects which source maps to which WebGL texture
  // Video elements keep stable src, we just swap which ref maps to which texture
  const { slotA: mediaA, slotB: mediaB } = applyFlipAB(
    { stableA: stableMediaA, stableB: stableMediaB },
    webglComparisonSettings.flipAB
  )

  // Key identifying everything a metrics computation depends on. Any change
  // (mode, A/B flip, segment switch, threshold, ROI) produces a new key,
  // which invalidates metrics computed under the previous context.
  const metricsContextKey = buildMetricsContextKey({
    mode: webglComparisonSettings.mode,
    flipAB: webglComparisonSettings.flipAB,
    urlA: stableMediaA?.url ?? null,
    urlB: stableMediaB?.url ?? null,
    threshold: webglComparisonSettings.threshold,
    roi: webglComparisonSettings.roi
  })

  // Use the optimized clip sync hook for videos (respects play/pause state)
  useOptimizedClipSync(videoARef, activeClipA || firstClipA)
  useOptimizedClipSync(videoBRef, activeClipB || firstClipB)

  // Track when videos are ready for texture upload (have decoded at least one frame)
  // Use stable media refs so flipAB doesn't reset this state
  const [videosReady, setVideosReady] = useState({ a: false, b: false })

  // Mirror the effective comparison state into a ref so the rAF render loop,
  // the throttled metrics scheduler and the export handlers always read the
  // CURRENT state instead of values captured by a stale closure.
  const latestRef = useRef({
    stableMediaA, stableMediaB, mediaA, mediaB,
    imagesLoaded, videosReady, mousePos, metricsContextKey
  })
  useLayoutEffect(() => {
    latestRef.current = {
      stableMediaA, stableMediaB, mediaA, mediaB,
      imagesLoaded, videosReady, mousePos, metricsContextKey
    }
  })

  // State consistency: when the metrics context changes (mode, A/B flip,
  // segment switch, threshold, ROI), synchronously invalidate everything
  // derived from the previous context BEFORE the browser can paint again.
  const prevContextKeyRef = useRef(metricsContextKey)
  useLayoutEffect(() => {
    if (prevContextKeyRef.current === metricsContextKey) return
    prevContextKeyRef.current = metricsContextKey
    // Cancel any queued/in-flight metrics computation...
    metricsGenerationRef.current++
    // ...drop metrics from the previous context so the overlay waits for a
    // fresh computation instead of showing stale SSIM/DeltaE/diff counts...
    setWebGLAnalysisMetrics(null)
    // ...and clear picker values sampled under the previous context (e.g.
    // pre-flip A/B mapping) so the panel can't contradict the picture.
    setCursorPixelInfo({ a: null, b: null })
  }, [metricsContextKey, setWebGLAnalysisMetrics])

  // State consistency: when the media feeding a texture slot changes (segment
  // switch or A/B flip), invalidate the slot's texture synchronously so frames
  // from the previous clip are never rendered as the newly active one.
  const slotUrlA = mediaA?.url ?? null
  const slotUrlB = mediaB?.url ?? null
  useLayoutEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    if (renderer.getTextureSourceKey('A') !== slotUrlA) renderer.invalidateTexture('A')
    if (renderer.getTextureSourceKey('B') !== slotUrlB) renderer.invalidateTexture('B')
  }, [slotUrlA, slotUrlB])

  // Reset readiness synchronously when the actual source URLs change (not on
  // flip) so stale frames are never uploaded or sampled while the new segment
  // is still loading.
  const stableUrlA = stableMediaA?.url ?? null
  const stableUrlB = stableMediaB?.url ?? null
  useLayoutEffect(() => {
    setVideosReady(prev => (prev.a || prev.b) ? { a: false, b: false } : prev)
    setImagesLoaded(prev => (prev.a || prev.b) ? { a: false, b: false } : prev)
  }, [stableUrlA, stableUrlB])

  // Ensure videos load their first frame for texture (even when paused)
  // IMPORTANT: Use stableMediaA/B URLs so this doesn't reset when flipAB changes.
  // Readiness reset on URL change is handled synchronously by a layout effect above.
  useEffect(() => {
    const videoA = videoARef.current
    const videoB = videoBRef.current

    const handleLoadedDataA = () => {
      setVideosReady(prev => (prev.a ? prev : { ...prev, a: true }))
    }
    const handleLoadedDataB = () => {
      setVideosReady(prev => (prev.b ? prev : { ...prev, b: true }))
    }

    // Small delay to let video elements update their src
    const checkReady = setTimeout(() => {
      if (videoA && stableMediaA?.type === 'video') {
        videoA.addEventListener('loadeddata', handleLoadedDataA)
        // If already loaded, mark as ready. currentSrc must match the URL in
        // effect — right after a src change readyState may still describe the
        // PREVIOUS resource, which must not count as ready.
        if (videoA.readyState >= 2 && videoA.currentSrc === stableMediaA.url) {
          setVideosReady(prev => (prev.a ? prev : { ...prev, a: true }))
        }
      }
      if (videoB && stableMediaB?.type === 'video') {
        videoB.addEventListener('loadeddata', handleLoadedDataB)
        if (videoB.readyState >= 2 && videoB.currentSrc === stableMediaB.url) {
          setVideosReady(prev => (prev.b ? prev : { ...prev, b: true }))
        }
      }
      // Images may already be complete (cache) before onLoad gets a chance to fire
      if (imgARef.current && stableMediaA?.type === 'image' && imgARef.current.complete && imgARef.current.naturalWidth > 0) {
        setImagesLoaded(prev => (prev.a ? prev : { ...prev, a: true }))
      }
      if (imgBRef.current && stableMediaB?.type === 'image' && imgBRef.current.complete && imgBRef.current.naturalWidth > 0) {
        setImagesLoaded(prev => (prev.b ? prev : { ...prev, b: true }))
      }
    }, 50)

    return () => {
      clearTimeout(checkReady)
      videoA?.removeEventListener('loadeddata', handleLoadedDataA)
      videoB?.removeEventListener('loadeddata', handleLoadedDataB)
    }
  }, [stableMediaA?.url, stableMediaB?.url, stableMediaA?.type, stableMediaB?.type])

  // Initialize renderer
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return

    // Check WebGL support
    if (!WebGLComparisonRenderer.isSupported()) {
      setIsSupported(false)
      return
    }

    const container = containerRef.current
    const canvas = canvasRef.current
    let isCleanedUp = false
    let retryCount = 0

    // Function to initialize renderer with proper dimensions
    const initRenderer = () => {
      if (isCleanedUp) return

      const rect = container.getBoundingClientRect()
      let width = rect.width
      let height = rect.height

      // If container has no dimensions, try again (max 10 retries)
      if ((width <= 0 || height <= 0) && retryCount < 10) {
        retryCount++
        setTimeout(initRenderer, 100)
        return
      }

      // Set canvas dimensions with minimum
      width = Math.max(Math.round(width), 640)
      height = Math.max(Math.round(height), 480)

      canvas.width = width
      canvas.height = height

      const renderer = new WebGLComparisonRenderer(canvas)
      rendererRef.current = renderer

      // Set the mode from store
      renderer.setMode(webglComparisonSettings.mode)
    }

    // Wait a frame to ensure container is laid out
    const timeoutId = setTimeout(initRenderer, 50)

    return () => {
      isCleanedUp = true
      clearTimeout(timeoutId)
      if (rendererRef.current) {
        rendererRef.current.dispose()
        rendererRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Intentionally empty - mode changes handled by separate effect

  // Update mode when settings change
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setMode(webglComparisonSettings.mode)
    }
  }, [webglComparisonSettings.mode])

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return

      const { width, height } = entry.contentRect

      // Validate dimensions before setting
      if (width <= 0 || height <= 0) {
        console.log('[WebGL Component] ResizeObserver skipping invalid dimensions:', width, 'x', height)
        return
      }

      // Round to integers
      const w = Math.round(width)
      const h = Math.round(height)

      // Only update if renderer exists and dimensions changed
      if (rendererRef.current) {
        rendererRef.current.resize(w, h)
      } else {
        // If no renderer yet, just set canvas dimensions
        canvas.width = Math.max(w, 100)
        canvas.height = Math.max(h, 100)
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Render function - reads the effective state from latestRef on every frame
  // so it can never upload or draw content for a stale mode/segment/flip state.
  const render = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) {
      animationRef.current = requestAnimationFrame(render)
      return
    }

    // Get current settings from store to avoid stale closure issues
    const settings = useProjectStore.getState().webglComparisonSettings
    const flipAB = settings.flipAB
    const {
      stableMediaA, stableMediaB,
      imagesLoaded, videosReady, mousePos
    } = latestRef.current

    // Determine which video/image ref maps to which texture based on flipAB
    // Video elements always have stable sources, we just swap texture assignment
    const textureASource = flipAB ? videoBRef.current : videoARef.current
    const textureBSource = flipAB ? videoARef.current : videoBRef.current
    const imgASource = flipAB ? imgBRef.current : imgARef.current
    const imgBSource = flipAB ? imgARef.current : imgBRef.current
    const mediaForA = flipAB ? stableMediaB : stableMediaA
    const mediaForB = flipAB ? stableMediaA : stableMediaB
    const readyA = flipAB ? videosReady.b : videosReady.a
    const readyB = flipAB ? videosReady.a : videosReady.b
    const imgLoadedA = flipAB ? imagesLoaded.b : imagesLoaded.a
    const imgLoadedB = flipAB ? imagesLoaded.a : imagesLoaded.b

    // Upload the current source to a texture slot, or invalidate the slot if
    // the source in effect is not ready. A slot must NEVER keep content whose
    // identity (URL) differs from the media currently in effect — that is how
    // stale frames from a previous clip leak into the picture.
    const syncTextureSlot = (
      which: 'A' | 'B',
      media: MediaFile | null,
      videoEl: HTMLVideoElement | null,
      imgEl: HTMLImageElement | null,
      videoReady: boolean,
      imgReady: boolean
    ): HTMLVideoElement | HTMLImageElement | null => {
      const key = media?.url ?? null
      if (media?.type === 'video' && videoEl && videoReady && videoEl.readyState >= 2 && elementMatchesUrl(videoEl, media.url)) {
        renderer.updateTexture(which, videoEl, key ?? undefined)
        return videoEl
      }
      if (media?.type === 'image' && imgEl && imgReady && elementMatchesUrl(imgEl, media.url)) {
        renderer.updateTexture(which, imgEl, key ?? undefined)
        return imgEl
      }
      if (renderer.getTextureSourceKey(which) !== key) {
        renderer.invalidateTexture(which)
      }
      return null
    }

    const uploadedA = syncTextureSlot('A', mediaForA, textureASource, imgASource, readyA, imgLoadedA)
    const uploadedB = syncTextureSlot('B', mediaForB, textureBSource, imgBSource, readyB, imgLoadedB)

    // Get media dimensions for aspect ratio correction
    const dimsOf = (media: MediaFile | null, el: HTMLVideoElement | HTMLImageElement | null) => {
      if (media?.type === 'video' && el && 'videoWidth' in el) {
        return { width: el.videoWidth || 1920, height: el.videoHeight || 1080 }
      }
      if (media?.type === 'image' && el && 'naturalWidth' in el) {
        return { width: el.naturalWidth || 1920, height: el.naturalHeight || 1080 }
      }
      if (media?.width && media?.height) {
        return { width: media.width, height: media.height }
      }
      return { width: 1920, height: 1080 }
    }

    const dimsA = dimsOf(mediaForA, uploadedA)
    const dimsB = dimsOf(mediaForB, uploadedB)

    // Render with current settings (read fresh from store)
    renderer.render({
      amplification: settings.amplification,
      threshold: settings.threshold,
      opacity: settings.opacity,
      blockSize: settings.blockSize,
      loupeSize: settings.loupeSize,
      loupeZoom: settings.loupeZoom,
      checkerSize: settings.checkerSize,
      mouseX: mousePos.x,
      mouseY: mousePos.y,
      textureAWidth: dimsA.width,
      textureAHeight: dimsA.height,
      textureBWidth: dimsB.width,
      textureBHeight: dimsB.height
    })

    // Continue animation loop
    animationRef.current = requestAnimationFrame(render)
  }, [])

  // Start render loop
  useEffect(() => {
    animationRef.current = requestAnimationFrame(render)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [render])

  // WEBGL-001: Compute metrics periodically (every 500ms)
  // Reads the CURRENT effective state on every tick (never stale closures) and
  // tags results with the context they were computed for. Queued computations
  // are cancellable: if the context changes, the generation bump prevents the
  // queued tick from writing stale results.
  useEffect(() => {
    if (!webglComparisonSettings.showMetricsOverlay) {
      return
    }

    let cancelled = false

    const computeMetrics = () => {
      if (cancelled) return

      const now = Date.now()
      // Only compute every 500ms to avoid performance issues
      if (now - lastMetricsTimeRef.current < 500) {
        metricsTimerRef.current = requestAnimationFrame(computeMetrics)
        return
      }

      // Read the state in effect RIGHT NOW — a queued tick must never compute
      // or write results for a mode/segment that is no longer active.
      const settings = useProjectStore.getState().webglComparisonSettings
      const {
        stableMediaA, stableMediaB,
        imagesLoaded, videosReady, metricsContextKey
      } = latestRef.current
      const generation = metricsGenerationRef.current
      const flipAB = settings.flipAB

      // Get source elements - respect flipAB for correct A/B mapping
      const mediaForA = flipAB ? stableMediaB : stableMediaA
      const mediaForB = flipAB ? stableMediaA : stableMediaB
      const videoElA = flipAB ? videoBRef.current : videoARef.current
      const videoElB = flipAB ? videoARef.current : videoBRef.current
      const imgElA = flipAB ? imgBRef.current : imgARef.current
      const imgElB = flipAB ? imgARef.current : imgBRef.current
      const readyA = flipAB ? videosReady.b : videosReady.a
      const readyB = flipAB ? videosReady.a : videosReady.b
      const imgLoadedA = flipAB ? imagesLoaded.b : imagesLoaded.a
      const imgLoadedB = flipAB ? imagesLoaded.a : imagesLoaded.b

      // Only sample elements that are ready AND still hold the URL in effect —
      // never compute metrics from a previous segment's frames.
      const resolveSource = (
        media: MediaFile | null,
        videoEl: HTMLVideoElement | null,
        imgEl: HTMLImageElement | null,
        videoReady: boolean,
        imgReady: boolean
      ): HTMLVideoElement | HTMLImageElement | null => {
        if (media?.type === 'video' && videoEl && videoReady && videoEl.readyState >= 2 && elementMatchesUrl(videoEl, media.url)) {
          return videoEl
        }
        if (media?.type === 'image' && imgEl && imgReady && elementMatchesUrl(imgEl, media.url)) {
          return imgEl
        }
        return null
      }

      const sourceA = resolveSource(mediaForA, videoElA, imgElA, readyA, imgLoadedA)
      const sourceB = resolveSource(mediaForB, videoElB, imgElB, readyB, imgLoadedB)

      if (sourceA && sourceB && rendererRef.current) {
        const gl = (rendererRef.current as unknown as { gl: WebGLRenderingContext | null }).gl
        if (gl) {
          lastMetricsTimeRef.current = now
          const metrics = computeMetricsFromWebGLCanvas(
            gl,
            canvasRef.current?.width || 640,
            canvasRef.current?.height || 480,
            sourceA,
            sourceB,
            Math.round(settings.threshold * 255),
            settings.roi // WEBGL-004: Pass ROI for localized metrics
          )
          // Cancellation: if the context changed since this tick started,
          // drop the result instead of writing stale metrics.
          if (!cancelled && generation === metricsGenerationRef.current) {
            setWebGLAnalysisMetrics({ ...metrics, contextKey: metricsContextKey })
          }
        }
      }

      metricsTimerRef.current = requestAnimationFrame(computeMetrics)
    }

    metricsTimerRef.current = requestAnimationFrame(computeMetrics)

    return () => {
      cancelled = true
      if (metricsTimerRef.current) {
        cancelAnimationFrame(metricsTimerRef.current)
      }
    }
  }, [webglComparisonSettings.showMetricsOverlay, setWebGLAnalysisMetrics])

  // Handle mouse move for interactive modes
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = 1.0 - (e.clientY - rect.top) / rect.height // Flip Y for WebGL
    const yScreen = (e.clientY - rect.top) / rect.height // Normal Y for ROI
    setMousePos({ x, y })
    setScreenMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })

    // WEBGL-004: Handle ROI drawing
    if (isDrawingROI) {
      const roiX = Math.min(roiStart.x, x)
      const roiY = Math.min(roiStart.y, yScreen)
      const roiWidth = Math.abs(x - roiStart.x)
      const roiHeight = Math.abs(yScreen - roiStart.y)
      setTempROI({ x: roiX, y: roiY, width: roiWidth, height: roiHeight })
      return
    }

    // WEBGL-007: Handle pan dragging
    if (isDragging && webglComparisonSettings.webglZoom > 1) {
      const dx = (e.clientX - dragStart.x) / rect.width
      const dy = (e.clientY - dragStart.y) / rect.height
      setWebGLPan(
        webglComparisonSettings.webglPanX + dx * 2,
        webglComparisonSettings.webglPanY - dy * 2
      )
      setDragStart({ x: e.clientX, y: e.clientY })
    }

    // WEBGL-003: Sample pixel values at cursor position
    // Use stable sources with flipAB handling for correct A/B mapping
    if (webglComparisonSettings.showCursorInspector) {
      const sampleCanvas = document.createElement('canvas')
      sampleCanvas.width = 1
      sampleCanvas.height = 1
      const ctx = sampleCanvas.getContext('2d')

      if (ctx) {
        let pixelA: { r: number; g: number; b: number } | null = null
        let pixelB: { r: number; g: number; b: number } | null = null

        // Respect flipAB for correct A/B mapping
        const flipAB = webglComparisonSettings.flipAB
        const mediaForA = flipAB ? stableMediaB : stableMediaA
        const mediaForB = flipAB ? stableMediaA : stableMediaB
        const videoRefA = flipAB ? videoBRef : videoARef
        const videoRefB = flipAB ? videoARef : videoBRef
        const imgRefA = flipAB ? imgBRef : imgARef
        const imgRefB = flipAB ? imgARef : imgBRef

        // Only sample elements that actually hold the media in effect —
        // never read pixels from a previous segment's frames.
        const pickSampleSource = (
          media: MediaFile | null,
          videoEl: HTMLVideoElement | null,
          imgEl: HTMLImageElement | null
        ): HTMLVideoElement | HTMLImageElement | null => {
          if (media?.type === 'video' && videoEl && videoEl.readyState >= 2 && elementMatchesUrl(videoEl, media.url)) {
            return videoEl
          }
          if (media?.type === 'image' && imgEl && imgEl.complete && imgEl.naturalWidth > 0 && elementMatchesUrl(imgEl, media.url)) {
            return imgEl
          }
          return null
        }

        // Sample from source A
        const sourceA = pickSampleSource(mediaForA, videoRefA.current, imgRefA.current)
        if (sourceA) {
          const srcWidth = 'videoWidth' in sourceA ? sourceA.videoWidth : sourceA.naturalWidth
          const srcHeight = 'videoHeight' in sourceA ? sourceA.videoHeight : sourceA.naturalHeight
          ctx.drawImage(sourceA, x * srcWidth, (1 - y) * srcHeight, 1, 1, 0, 0, 1, 1)
          const data = ctx.getImageData(0, 0, 1, 1).data
          pixelA = { r: data[0], g: data[1], b: data[2] }
        }

        // Sample from source B
        const sourceB = pickSampleSource(mediaForB, videoRefB.current, imgRefB.current)
        if (sourceB) {
          const srcWidth = 'videoWidth' in sourceB ? sourceB.videoWidth : sourceB.naturalWidth
          const srcHeight = 'videoHeight' in sourceB ? sourceB.videoHeight : sourceB.naturalHeight
          ctx.drawImage(sourceB, x * srcWidth, (1 - y) * srcHeight, 1, 1, 0, 0, 1, 1)
          const data = ctx.getImageData(0, 0, 1, 1).data
          pixelB = { r: data[0], g: data[1], b: data[2] }
        }

        setCursorPixelInfo({ a: pixelA, b: pixelB })
      }
    }
  }, [isDragging, dragStart, isDrawingROI, roiStart, webglComparisonSettings.webglZoom, webglComparisonSettings.webglPanX, webglComparisonSettings.webglPanY, webglComparisonSettings.showCursorInspector, webglComparisonSettings.flipAB, setWebGLPan, stableMediaA, stableMediaB])

  // WEBGL-007: Handle mouse wheel for zoom
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.5 : 0.5
    setWebGLZoom(webglComparisonSettings.webglZoom + delta)
  }, [webglComparisonSettings.webglZoom, setWebGLZoom])

  // WEBGL-007: Handle mouse down for pan / WEBGL-004: Handle mouse down for ROI
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    // WEBGL-004: Start ROI drawing if ROI controls are enabled
    if (webglComparisonSettings.showROIControls) {
      setIsDrawingROI(true)
      setROIStart({ x, y })
      setTempROI({ x, y, width: 0, height: 0 })
      return
    }

    // WEBGL-007: Start panning if zoomed
    if (webglComparisonSettings.webglZoom > 1) {
      setIsDragging(true)
      setDragStart({ x: e.clientX, y: e.clientY })
    }
  }, [webglComparisonSettings.webglZoom, webglComparisonSettings.showROIControls])

  // WEBGL-007: Handle mouse up / WEBGL-004: Commit ROI
  const handleMouseUp = useCallback(() => {
    // WEBGL-004: Commit ROI if drawing
    if (isDrawingROI && tempROI) {
      // Only set ROI if it has a reasonable size (more than 1% in each dimension)
      if (tempROI.width > 0.01 && tempROI.height > 0.01) {
        setROI(tempROI)
      }
      setIsDrawingROI(false)
      setTempROI(null)
      return
    }

    setIsDragging(false)
  }, [isDrawingROI, tempROI, setROI])

  // WEBGL-007: Handle double click to reset zoom
  const handleDoubleClick = useCallback(() => {
    resetWebGLZoom()
  }, [resetWebGLZoom])

  // SCOPE-010: Handle G key for gamut warning toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        setShowGamutWarning(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // WEBGL-005: Export Analysis Screenshot
  const exportScreenshot = useCallback(async (copyToClipboard: boolean = false) => {
    if (!canvasRef.current || !containerRef.current) return

    // Read the state in effect at export time — the export must match what is
    // on screen RIGHT NOW, never values captured before a mode/flip/segment
    // change.
    const settings = useProjectStore.getState().webglComparisonSettings
    const storedMetrics = useProjectStore.getState().webglAnalysisMetrics
    const exportMetrics = isMetricsCurrent(storedMetrics, latestRef.current.metricsContextKey)
      ? storedMetrics
      : null

    // Create a canvas that includes the WebGL content and overlays
    const exportCanvas = document.createElement('canvas')
    const scale = 2 // 2x resolution for quality
    const width = containerRef.current.offsetWidth * scale
    const height = containerRef.current.offsetHeight * scale
    exportCanvas.width = width
    exportCanvas.height = height

    const ctx = exportCanvas.getContext('2d')
    if (!ctx) return

    // Draw the WebGL canvas
    ctx.drawImage(canvasRef.current, 0, 0, width, height)

    // Get mode info for label
    const currentModeInfo = getComparisonModeInfo(settings.mode)

    // Draw mode indicator
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(16 * scale, 16 * scale, 200 * scale, 30 * scale)
    ctx.fillStyle = '#888888'
    ctx.font = `${14 * scale}px system-ui`
    ctx.fillText('Mode: ', 24 * scale, 36 * scale)
    ctx.fillStyle = '#cddc39'
    ctx.fillText(
      `${currentModeInfo?.label || settings.mode}${settings.flipAB ? ' (A/B Flipped)' : ''}`,
      70 * scale,
      36 * scale
    )

    // Draw metrics if visible — only metrics computed for the current context
    if (settings.showMetricsOverlay && exportMetrics) {
      const metricsX = width - 200 * scale
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
      ctx.fillRect(metricsX, 16 * scale, 180 * scale, 140 * scale)

      ctx.fillStyle = '#888888'
      ctx.font = `bold ${10 * scale}px system-ui`
      ctx.fillText('ANALYSIS METRICS', metricsX + 16 * scale, 36 * scale)

      ctx.font = `${12 * scale}px monospace`
      const metrics = [
        { label: 'SSIM:', value: exportMetrics.ssim.toFixed(4) },
        { label: 'Delta E:', value: exportMetrics.deltaE.toFixed(2) },
        { label: 'Diff Pixels:', value: `${exportMetrics.diffPixelPercent.toFixed(1)}%` },
        { label: 'Peak Diff:', value: exportMetrics.peakDifference.toFixed(0) },
        { label: 'Mean Diff:', value: exportMetrics.meanDifference.toFixed(1) }
      ]

      metrics.forEach((m, i) => {
        ctx.fillStyle = '#888888'
        ctx.fillText(m.label, metricsX + 16 * scale, (56 + i * 20) * scale)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(m.value, metricsX + 100 * scale, (56 + i * 20) * scale)
      })
    }

    // Draw timestamp
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(16 * scale, height - 46 * scale, 250 * scale, 30 * scale)
    ctx.fillStyle = '#888888'
    ctx.font = `${12 * scale}px system-ui`
    ctx.fillText(`DualView Analysis • ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, 24 * scale, height - 26 * scale)

    // Export
    if (copyToClipboard) {
      try {
        const blob = await new Promise<Blob | null>((resolve) => {
          exportCanvas.toBlob(resolve, 'image/png')
        })
        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ])
        }
      } catch (err) {
        console.error('Failed to copy to clipboard:', err)
      }
    } else {
      const link = document.createElement('a')
      link.download = `dualview-analysis-${settings.mode}-${Date.now()}.png`
      link.href = exportCanvas.toDataURL('image/png')
      link.click()
    }
  }, [])

  // WEBGL-010: Export PDF Analysis Report
  const exportPDFReport = useCallback(async () => {
    if (!canvasRef.current) return

    // Read the state in effect at export time so the report matches the screen
    const settings = useProjectStore.getState().webglComparisonSettings
    const storedMetrics = useProjectStore.getState().webglAnalysisMetrics
    const { mediaA: currentMediaA, mediaB: currentMediaB, metricsContextKey } = latestRef.current
    const exportMetrics = isMetricsCurrent(storedMetrics, metricsContextKey) ? storedMetrics : null

    // Get mode info for the report
    const currentModeInfo = getComparisonModeInfo(settings.mode)

    // Capture screenshot for the PDF
    const screenshotBlob = await captureCanvasScreenshot(canvasRef.current, 'png')
    if (!screenshotBlob) return

    // Format file size helper
    const formatSize = (bytes?: number) => {
      if (!bytes) return 'Unknown'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    // Generate PDF
    const pdfBlob = await generatePDFReport({
      title: 'DualView WebGL Analysis Report',
      includeMetadata: true,
      includeAnnotations: false,
      includeSettings: true,
      screenshotBlob,
      comparisonMode: 'webgl-compare',
      webglMode: `${currentModeInfo?.label || settings.mode}${settings.flipAB ? ' (A/B Flipped)' : ''}`,
      threshold: settings.threshold,
      mediaA: currentMediaA ? {
        name: currentMediaA.name,
        type: currentMediaA.type,
        size: formatSize(currentMediaA.file?.size),
        dimensions: currentMediaA.width && currentMediaA.height ? `${currentMediaA.width}×${currentMediaA.height}` : undefined
      } : undefined,
      mediaB: currentMediaB ? {
        name: currentMediaB.name,
        type: currentMediaB.type,
        size: formatSize(currentMediaB.file?.size),
        dimensions: currentMediaB.width && currentMediaB.height ? `${currentMediaB.width}×${currentMediaB.height}` : undefined
      } : undefined,
      webglMetrics: exportMetrics ? {
        ssim: exportMetrics.ssim,
        deltaE: exportMetrics.deltaE,
        diffPixelPercent: exportMetrics.diffPixelPercent,
        peakDifference: exportMetrics.peakDifference,
        meanDifference: exportMetrics.meanDifference,
        passPixelCount: exportMetrics.passPixelCount,
        failPixelCount: exportMetrics.failPixelCount,
        totalPixelCount: exportMetrics.totalPixelCount
      } : undefined
    })

    // Download
    downloadBlob(pdfBlob, `dualview-analysis-report-${Date.now()}.pdf`)
  }, [])

  // Handle image load
  const handleImageALoad = useCallback(() => {
    setImagesLoaded(prev => ({ ...prev, a: true }))
  }, [])

  const handleImageBLoad = useCallback(() => {
    setImagesLoaded(prev => ({ ...prev, b: true }))
  }, [])

  // Handle file upload for empty state
  const handleUpload = useCallback(async (files: FileList | null, targetTrack: 'a' | 'b') => {
    if (!files || files.length === 0) return

    const file = files[0]
    try {
      const mediaFile = await addFile(file)
      // Get fresh track references from the store to avoid stale closures
      const currentTracks = useTimelineStore.getState().tracks
      const track = currentTracks.find(t => t.type === targetTrack)

      if (track) {
        const duration = mediaFile.duration || 10
        addClip(track.id, mediaFile.id, 0, duration)
      }
    } catch (error) {
      console.error('Failed to upload media:', error)
    }
  }, [addFile, addClip])

  // Trigger file input
  const triggerUpload = useCallback((track: 'a' | 'b') => {
    currentUploadTarget.current = { track }
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }, [])

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (currentUploadTarget.current) {
      handleUpload(e.target.files, currentUploadTarget.current.track)
      e.target.value = '' // Reset for re-upload
    }
  }, [handleUpload])

  // Get current mode info
  const modeInfo = getComparisonModeInfo(webglComparisonSettings.mode)

  if (!isSupported) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#1a1a1a]">
        <div className="text-center p-8">
          <div className="text-4xl mb-4">⚠️</div>
          <h3 className="text-xl font-bold text-white mb-2">WebGL Not Supported</h3>
          <p className="text-gray-400">
            Your browser doesn't support WebGL, which is required for GPU-accelerated comparison modes.
          </p>
          <p className="text-gray-500 mt-2 text-sm">
            Try using a modern browser like Chrome, Firefox, or Edge.
          </p>
        </div>
      </div>
    )
  }

  if (!mediaA && !mediaB) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#1a1a1a] p-4">
        <div className="text-center max-w-2xl w-full">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={handleFileChange}
          />

          <h2 className="text-lg font-semibold text-white mb-1">Difference Mode</h2>
          <p className="text-xs text-gray-400 mb-4">
            Upload images or videos to compare with advanced analysis
          </p>

          {/* Upload sections for Track A and Track B */}
          <div className="grid grid-cols-2 gap-4">
            {/* Track A Upload */}
            <div className="p-3 bg-[#252525] border border-orange-500/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 bg-orange-500/20 flex items-center justify-center">
                  <span className="text-orange-400 font-bold text-xs">A</span>
                </div>
                <span className="text-sm font-medium text-orange-400">Media A</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => triggerUpload('a')}
                  className="flex flex-col items-center gap-1 p-3 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-all"
                >
                  <Image className="w-5 h-5 text-blue-400" />
                  <span className="text-[10px] font-medium text-blue-400">Image</span>
                </button>
                <button
                  onClick={() => triggerUpload('a')}
                  className="flex flex-col items-center gap-1 p-3 border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 transition-all"
                >
                  <Video className="w-5 h-5 text-purple-400" />
                  <span className="text-[10px] font-medium text-purple-400">Video</span>
                </button>
              </div>
            </div>

            {/* Track B Upload */}
            <div className="p-3 bg-[#252525] border border-lime-400/30">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 bg-lime-400/20 flex items-center justify-center">
                  <span className="text-lime-400 font-bold text-xs">B</span>
                </div>
                <span className="text-sm font-medium text-lime-400">Media B</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => triggerUpload('b')}
                  className="flex flex-col items-center gap-1 p-3 border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-all"
                >
                  <Image className="w-5 h-5 text-blue-400" />
                  <span className="text-[10px] font-medium text-blue-400">Image</span>
                </button>
                <button
                  onClick={() => triggerUpload('b')}
                  className="flex flex-col items-center gap-1 p-3 border border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 transition-all"
                >
                  <Video className="w-5 h-5 text-purple-400" />
                  <span className="text-[10px] font-medium text-purple-400">Video</span>
                </button>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-gray-500 mt-3">
            Current mode: <span className="text-[#cddc39]">{modeInfo?.label || webglComparisonSettings.mode}</span>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative bg-black overflow-hidden"
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      style={{ cursor: isDrawingROI ? 'crosshair' : webglComparisonSettings.showROIControls ? 'crosshair' : isDragging ? 'grabbing' : webglComparisonSettings.webglZoom > 1 ? 'grab' : 'default' }}
    >
      {/* Video elements for texture sources - STABLE sources, never swapped by flipAB */}
      <video
        ref={videoARef}
        src={stableMediaA?.type === 'video' ? stableMediaA.url : undefined}
        style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', zIndex: -1 }}
        muted
        playsInline
        loop
        preload="auto"
      />
      <video
        ref={videoBRef}
        src={stableMediaB?.type === 'video' ? stableMediaB.url : undefined}
        style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none', zIndex: -1 }}
        muted
        playsInline
        loop
        preload="auto"
      />

      {/* Hidden image elements for texture sources - STABLE sources */}
      {stableMediaA?.type === 'image' && (
        <img
          ref={imgARef}
          src={stableMediaA.url}
          className="hidden"
          onLoad={handleImageALoad}
          alt=""
        />
      )}
      {stableMediaB?.type === 'image' && (
        <img
          ref={imgBRef}
          src={stableMediaB.url}
          className="hidden"
          onLoad={handleImageBLoad}
          alt=""
        />
      )}

      {/* WebGL Canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{
          minWidth: '640px',
          minHeight: '480px',
          transform: `scale(${webglComparisonSettings.webglZoom}) translate(${webglComparisonSettings.webglPanX * 50 / webglComparisonSettings.webglZoom}%, ${-webglComparisonSettings.webglPanY * 50 / webglComparisonSettings.webglZoom}%)`,
          transformOrigin: 'center center'
        }}
      />

      {/* Mode indicator */}
      <div className="absolute top-4 left-4 bg-black/70 px-3 py-1.5 rounded text-sm">
        <span className="text-gray-400">Mode:</span>
        <span className="text-[#cddc39] ml-2 font-medium">{modeInfo?.label || webglComparisonSettings.mode}</span>
        {webglComparisonSettings.flipAB && (
          <span className="text-orange-400 ml-2">(A/B Flipped)</span>
        )}
      </div>

      {/* WEBGL-001: Metrics Overlay — only shown when the stored metrics were
          computed for the context currently in effect (mode/flip/segment) */}
      {webglComparisonSettings.showMetricsOverlay && webglAnalysisMetrics && isMetricsCurrent(webglAnalysisMetrics, metricsContextKey) && (
        <div className="absolute top-4 right-4 bg-black/80 px-4 py-3 rounded text-sm font-mono">
          <div className="text-gray-300 font-semibold mb-2 text-xs uppercase tracking-wider">Analysis Metrics</div>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">SSIM:</span>
              <span className={`font-medium ${webglAnalysisMetrics.ssim > 0.95 ? 'text-green-400' : webglAnalysisMetrics.ssim > 0.8 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.ssim.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Delta E:</span>
              <span className={`font-medium ${webglAnalysisMetrics.deltaE < 1 ? 'text-green-400' : webglAnalysisMetrics.deltaE < 5 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.deltaE.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Diff Pixels:</span>
              <span className={`font-medium ${webglAnalysisMetrics.diffPixelPercent < 1 ? 'text-green-400' : webglAnalysisMetrics.diffPixelPercent < 10 ? 'text-yellow-400' : 'text-red-400'}`}>
                {webglAnalysisMetrics.diffPixelPercent.toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Peak Diff:</span>
              <span className="text-gray-200 font-medium">{webglAnalysisMetrics.peakDifference.toFixed(0)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-gray-400">Mean Diff:</span>
              <span className="text-gray-200 font-medium">{webglAnalysisMetrics.meanDifference.toFixed(1)}</span>
            </div>
            {/* WEBGL-006: Threshold Pass/Fail Stats */}
            <div className="border-t border-gray-600 mt-2 pt-2">
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Pass:</span>
                <span className="text-green-400 font-medium">
                  {webglAnalysisMetrics.passPixelCount.toLocaleString()} ({((webglAnalysisMetrics.passPixelCount / webglAnalysisMetrics.totalPixelCount) * 100).toFixed(1)}%)
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-gray-400">Fail:</span>
                <span className="text-red-400 font-medium">
                  {webglAnalysisMetrics.failPixelCount.toLocaleString()} ({((webglAnalysisMetrics.failPixelCount / webglAnalysisMetrics.totalPixelCount) * 100).toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WEBGL-002: Scale Bar */}
      {webglComparisonSettings.showScaleBar && (
        <div className={`absolute ${
          webglComparisonSettings.scaleBarPosition === 'top' ? 'top-16 left-1/2 -translate-x-1/2' :
          webglComparisonSettings.scaleBarPosition === 'bottom' ? 'bottom-16 left-1/2 -translate-x-1/2' :
          webglComparisonSettings.scaleBarPosition === 'left' ? 'left-4 top-1/2 -translate-y-1/2' :
          'right-4 top-1/2 -translate-y-1/2'
        } bg-black/70 p-2 rounded`}>
          {(webglComparisonSettings.scaleBarPosition === 'top' || webglComparisonSettings.scaleBarPosition === 'bottom') ? (
            <div className="flex flex-col items-center">
              <div className="w-48 h-4 rounded" style={{
                background: 'linear-gradient(to right, #000000, #ff0000, #ffff00, #ffffff)'
              }} />
              <div className="flex justify-between w-48 text-xs text-gray-400 mt-1">
                <span>0</span>
                <span>Low</span>
                <span>Mid</span>
                <span>High</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-4 h-48 rounded" style={{
                background: 'linear-gradient(to top, #000000, #ff0000, #ffff00, #ffffff)'
              }} />
              <div className="flex flex-col justify-between h-48 text-xs text-gray-400">
                <span>High</span>
                <span>Mid</span>
                <span>Low</span>
                <span>0</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* WEBGL-007: Zoom indicator */}
      {webglComparisonSettings.webglZoom > 1 && (
        <div className="absolute top-14 left-4 bg-black/70 px-2 py-1 rounded text-xs text-gray-400">
          Zoom: {webglComparisonSettings.webglZoom.toFixed(1)}x • Double-click to reset
        </div>
      )}

      {/* WEBGL-003: Cursor Value Inspector */}
      {webglComparisonSettings.showCursorInspector && cursorPixelInfo.a && cursorPixelInfo.b && (
        <div
          className="absolute pointer-events-none bg-black/90 px-3 py-2 rounded text-xs font-mono z-50"
          style={{
            left: Math.min(screenMousePos.x + 20, (containerRef.current?.offsetWidth || 400) - 180),
            top: Math.min(screenMousePos.y + 20, (containerRef.current?.offsetHeight || 300) - 120)
          }}
        >
          <div className="text-gray-300 font-semibold mb-1">Pixel Inspector</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <div className="text-gray-500">Source A:</div>
            <div className="flex items-center gap-1">
              <span style={{ color: `rgb(${cursorPixelInfo.a.r}, 100, 100)` }}>{cursorPixelInfo.a.r}</span>
              <span style={{ color: `rgb(100, ${cursorPixelInfo.a.g}, 100)` }}>{cursorPixelInfo.a.g}</span>
              <span style={{ color: `rgb(100, 100, ${cursorPixelInfo.a.b})` }}>{cursorPixelInfo.a.b}</span>
              <span
                className="w-3 h-3 rounded-sm ml-1"
                style={{ backgroundColor: `rgb(${cursorPixelInfo.a.r}, ${cursorPixelInfo.a.g}, ${cursorPixelInfo.a.b})` }}
              />
            </div>
            <div className="text-gray-500">Source B:</div>
            <div className="flex items-center gap-1">
              <span style={{ color: `rgb(${cursorPixelInfo.b.r}, 100, 100)` }}>{cursorPixelInfo.b.r}</span>
              <span style={{ color: `rgb(100, ${cursorPixelInfo.b.g}, 100)` }}>{cursorPixelInfo.b.g}</span>
              <span style={{ color: `rgb(100, 100, ${cursorPixelInfo.b.b})` }}>{cursorPixelInfo.b.b}</span>
              <span
                className="w-3 h-3 rounded-sm ml-1"
                style={{ backgroundColor: `rgb(${cursorPixelInfo.b.r}, ${cursorPixelInfo.b.g}, ${cursorPixelInfo.b.b})` }}
              />
            </div>
            <div className="text-gray-500">Diff:</div>
            <div className="text-orange-400">
              {Math.abs(cursorPixelInfo.a.r - cursorPixelInfo.b.r)} {Math.abs(cursorPixelInfo.a.g - cursorPixelInfo.b.g)} {Math.abs(cursorPixelInfo.a.b - cursorPixelInfo.b.b)}
            </div>
          </div>
        </div>
      )}

      {/* WEBGL-004: ROI Overlay */}
      {(webglComparisonSettings.roi || tempROI) && (
        <div
          className="absolute border-2 border-[#ff5722] pointer-events-none"
          style={{
            left: `${((tempROI || webglComparisonSettings.roi)!.x) * 100}%`,
            top: `${((tempROI || webglComparisonSettings.roi)!.y) * 100}%`,
            width: `${((tempROI || webglComparisonSettings.roi)!.width) * 100}%`,
            height: `${((tempROI || webglComparisonSettings.roi)!.height) * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)'
          }}
        >
          {/* ROI corner handles */}
          <div className="absolute -top-1 -left-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -bottom-1 -left-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-[#ff5722] rounded-sm" />
          {/* ROI label */}
          {!tempROI && (
            <div className="absolute -top-6 left-0 bg-[#ff5722] text-white text-xs px-2 py-0.5 rounded whitespace-nowrap">
              ROI: {(webglComparisonSettings.roi!.width * 100).toFixed(0)}% × {(webglComparisonSettings.roi!.height * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}

      {/* WEBGL-004: ROI Drawing Mode Indicator */}
      {webglComparisonSettings.showROIControls && !webglComparisonSettings.roi && !tempROI && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/70 px-4 py-2 rounded text-white text-sm">
            Click and drag to select a region of interest
          </div>
        </div>
      )}

      {/* Control buttons */}
      <div className="absolute top-4 right-4 flex gap-1" style={{ right: webglComparisonSettings.showMetricsOverlay ? '220px' : '16px' }}>
        {/* WEBGL-001: Toggle Metrics */}
        <button
          onClick={toggleWebGLMetricsOverlay}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showMetricsOverlay ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Metrics Overlay (WEBGL-001)"
        >
          <BarChart3 size={16} />
        </button>

        {/* WEBGL-002: Toggle Scale Bar */}
        <button
          onClick={toggleWebGLScaleBar}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showScaleBar ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Scale Bar (WEBGL-002)"
        >
          <Ruler size={16} />
        </button>

        {/* WEBGL-003: Toggle Cursor Inspector */}
        <button
          onClick={toggleWebGLCursorInspector}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showCursorInspector ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Toggle Cursor Inspector (WEBGL-003)"
        >
          <Crosshair size={16} />
        </button>

        {/* WEBGL-004: ROI Selection */}
        <button
          onClick={toggleROIControls}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.showROIControls ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Draw ROI Selection (WEBGL-004)"
        >
          <Scan size={16} />
        </button>
        {webglComparisonSettings.roi && (
          <button
            onClick={clearROI}
            className="p-2 rounded bg-black/70 text-red-400 hover:text-red-300 transition-colors"
            title="Clear ROI Selection"
          >
            <X size={16} />
          </button>
        )}

        {/* WEBGL-008: Flip A/B */}
        <button
          onClick={toggleWebGLFlipAB}
          className={`p-2 rounded transition-colors ${webglComparisonSettings.flipAB ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Flip A/B Sources (F)"
        >
          <FlipHorizontal size={16} />
        </button>

        {/* WEBGL-007: Zoom controls */}
        <button
          onClick={() => setWebGLZoom(webglComparisonSettings.webglZoom + 1)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={() => setWebGLZoom(webglComparisonSettings.webglZoom - 1)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          disabled={webglComparisonSettings.webglZoom <= 1}
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          onClick={resetWebGLZoom}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Reset Zoom"
        >
          <RotateCcw size={16} />
        </button>

        {/* Separator */}
        <div className="w-px h-6 bg-gray-600 mx-1" />

        {/* WEBGL-005: Screenshot Export */}
        <button
          onClick={() => exportScreenshot(false)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Save Screenshot (PNG)"
        >
          <Camera size={16} />
        </button>
        <button
          onClick={() => exportScreenshot(true)}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Copy to Clipboard"
        >
          <Copy size={16} />
        </button>

        {/* WEBGL-010: PDF Analysis Report */}
        <button
          onClick={exportPDFReport}
          className="p-2 rounded bg-black/70 text-gray-400 hover:text-white transition-colors"
          title="Export PDF Analysis Report (WEBGL-010)"
        >
          <FileText size={16} />
        </button>

        {/* WEBGL-011: Split View Toggle */}
        <SplitViewToggle onClick={() => setShowSplitView(!showSplitView)} isActive={showSplitView} />

        {/* WEBGL-015: Presets Toggle */}
        <PresetsToggle onClick={() => setShowPresetsPanel(!showPresetsPanel)} isActive={showPresetsPanel} />

        {/* WEBGL-013: Batch Comparison Toggle */}
        <BatchComparisonToggle onClick={() => setShowBatchComparison(true)} />

        {/* WEBGL-014: Custom Shader Editor Toggle */}
        <ShaderEditorToggle onClick={() => setShowShaderEditor(true)} />

        {/* WEBGL-009: Temporal Diff Graph Toggle (only for videos) */}
        {(mediaA?.type === 'video' || mediaB?.type === 'video') && (
          <>
            <div className="w-px h-6 bg-gray-600 mx-1" />
            <button
              onClick={() => setShowTemporalGraph(!showTemporalGraph)}
              className={`p-2 rounded transition-colors ${showTemporalGraph ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
              title="Temporal Difference Graph (WEBGL-009)"
            >
              <LineChart size={16} />
            </button>
          </>
        )}

        {/* Separator for Scopes */}
        <div className="w-px h-6 bg-gray-600 mx-1" />

        {/* SCOPE-008: Histogram Panel Toggle */}
        <button
          onClick={() => setShowHistogramPanel(!showHistogramPanel)}
          className={`p-2 rounded transition-colors ${showHistogramPanel ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Histogram Panel (SCOPE-008)"
        >
          <Activity size={16} />
        </button>

        {/* SCOPE-009: Color Wheel Panel Toggle */}
        <button
          onClick={() => setShowColorWheelPanel(!showColorWheelPanel)}
          className={`p-2 rounded transition-colors ${showColorWheelPanel ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Color Wheel Distribution (SCOPE-009)"
        >
          <Palette size={16} />
        </button>

        {/* SCOPE-010: Gamut Warning Toggle */}
        <button
          onClick={() => setShowGamutWarning(!showGamutWarning)}
          className={`p-2 rounded transition-colors ${showGamutWarning ? 'bg-[#ff5722] text-white' : 'bg-black/70 text-gray-400 hover:text-white'}`}
          title="Gamut Warning Overlay (SCOPE-010, G)"
        >
          <AlertTriangle size={16} />
        </button>
      </div>

      {/* Settings indicator */}
      <div className="absolute bottom-4 left-4 bg-black/70 px-3 py-1.5 rounded text-xs text-gray-400">
        Amp: {webglComparisonSettings.amplification}x |
        Threshold: {(webglComparisonSettings.threshold * 100).toFixed(0)}% |
        Opacity: {(webglComparisonSettings.opacity * 100).toFixed(0)}%
      </div>

      {/* Help text for interactive modes */}
      {webglComparisonSettings.mode === 'pro-loupe' && (
        <div className="absolute bottom-4 right-4 bg-black/70 px-3 py-1.5 rounded text-xs text-gray-400">
          Move cursor to inspect • Left = A, Right = B
        </div>
      )}

      {/* WEBGL-009: Temporal Difference Graph */}
      <TemporalDiffGraph
        videoARef={videoARef}
        videoBRef={videoBRef}
        isVisible={showTemporalGraph && (mediaA?.type === 'video' || mediaB?.type === 'video')}
      />

      {/* WEBGL-011: Split View */}
      <WebGLSplitView
        isVisible={showSplitView}
        onToggle={() => setShowSplitView(false)}
      />

      {/* WEBGL-015: Presets Panel */}
      <WebGLPresetsPanel
        isOpen={showPresetsPanel}
        onClose={() => setShowPresetsPanel(false)}
      />

      {/* WEBGL-013: Batch Comparison */}
      <BatchComparison
        isOpen={showBatchComparison}
        onClose={() => setShowBatchComparison(false)}
      />

      {/* WEBGL-014: Custom Shader Editor */}
      <CustomShaderEditor
        isOpen={showShaderEditor}
        onClose={() => setShowShaderEditor(false)}
        onApplyShader={(fragmentShader) => {
          // Apply custom shader to renderer
          if (rendererRef.current) {
            // Store the custom shader for use
            console.log('Custom shader applied:', fragmentShader.substring(0, 100) + '...')
          }
        }}
      />

      {/* SCOPE-008: Histogram Panel */}
      <HistogramPanel
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showHistogramPanel}
        onClose={() => setShowHistogramPanel(false)}
      />

      {/* SCOPE-009: Color Wheel Panel */}
      <ColorWheelPanel
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showColorWheelPanel}
        onClose={() => setShowColorWheelPanel(false)}
      />

      {/* SCOPE-010: Gamut Warning Overlay */}
      <GamutWarningOverlay
        videoARef={videoARef}
        videoBRef={videoBRef}
        imageARef={imgARef}
        imageBRef={imgBRef}
        isVisible={showGamutWarning}
        onClose={() => setShowGamutWarning(false)}
      />
    </div>
  )
}
