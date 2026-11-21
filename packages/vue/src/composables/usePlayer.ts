import type { PlayerError, PlayerState, Track } from '@vue-player/core'
import type { Ref } from 'vue'
import {
  createNativeAdapter,
  detectSourceType,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from '@vue-player/core'
import { onMounted, onUnmounted, reactive, readonly } from 'vue'

export interface PlayerControls {
  play: () => Promise<void>
  pause: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  setSpeed: (rate: number) => void
  setQuality: (value: number | 'auto') => void
  setTrack: (track: Track | null) => void
  toggleFullscreen: () => Promise<void>
  togglePiP: () => Promise<void>
  retry: () => void
}

const ERROR_MESSAGES: Record<number, string> = {
  1: 'Playback was aborted.',
  2: 'Network error — could not load the video.',
  3: 'The video format is not supported by your browser.',
  4: 'Video not found or format not supported.',
}

function makeDefaultState(): PlayerState {
  return {
    isPlaying: false,
    isPaused: true,
    isEnded: false,
    isLoading: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    isMuted: false,
    isFullscreen: false,
    isPiP: false,
    isLive: false,
    currentQuality: 'auto',
    availableQualities: [],
    playbackRate: 1,
    currentTrack: null,
    availableTracks: [],
    error: null,
  }
}

export function usePlayer(videoRef: Ref<HTMLVideoElement | null>) {
  const state = reactive<PlayerState>(makeDefaultState())

  let nativeAdapter: ReturnType<typeof createNativeAdapter> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hlsInstance: any = null
  let lastSrc = ''
  // Monotonic token identifying the latest loadSource() call. Every async
  // continuation (dynamic import, manifest/error callbacks, native load) must
  // capture it and bail out once a newer generation has taken over.
  let loadGeneration = 0

  function clearVideo() {
    const video = videoRef.value
    if (!video) return
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  function destroyAdapters() {
    nativeAdapter?.destroy()
    nativeAdapter = null
    hlsInstance?.destroy()
    hlsInstance = null
    // Always clear video element between source switches
    clearVideo()
  }

  function syncFromVideo(video: HTMLVideoElement) {
    state.isPlaying = !video.paused && !video.ended
    state.isPaused = video.paused
    state.isEnded = video.ended
    state.currentTime = video.currentTime
    state.duration = Number.isFinite(video.duration) ? video.duration : 0
    state.volume = video.volume
    state.isMuted = video.muted
    state.playbackRate = video.playbackRate
    state.isLive = video.duration === Infinity
    if (video.buffered.length > 0) {
      state.buffered = video.buffered.end(video.buffered.length - 1)
    }
  }

  async function loadSource(src: string) {
    const video = videoRef.value
    if (!video) return

    // Begin a new generation: tear down anything created by the previous one
    // (instances plus the media element's src) before a single field of state
    // is touched.
    const generation = ++loadGeneration
    lastSrc = src
    destroyAdapters()

    state.error = null
    state.isLoading = true
    state.currentTime = 0
    state.duration = 0
    state.buffered = 0
    state.isLive = false
    state.availableQualities = []
    state.currentQuality = 'auto'
    // Subtitles belong to the previous source — reset so no stale currentTrack
    // survives the switch. The default track of the new source is re-applied
    // once its metadata becomes ready.
    state.currentTrack = null

    const type = detectSourceType(src)

    if (type === 'hls') {
      try {
        const { default: Hls } = await import('hls.js')

        // A newer loadSource() may have started while the dynamic import was
        // in flight. Its destroyAdapters() could not see this instance, so we
        // must not create or register it — drop the whole continuation.
        if (generation !== loadGeneration) return

        if (!Hls.isSupported()) {
          // Safari — native HLS support. Guard one more time since the
          // awaited import could have resolved after a newer switch.
          if (generation !== loadGeneration) return
          video.src = src
          return
        }

        const hls = new Hls({ enableWorker: true })
        let destroyed = false
        const destroyHls = () => {
          if (destroyed) return
          destroyed = true
          hls.destroy()
          if (hlsInstance === hls) hlsInstance = null
        }

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (generation !== loadGeneration) {
            destroyHls()
            return
          }
          const seen = new Set<number>()
          state.availableQualities = (hls.levels as any[])
            .map((level, i) => ({
              value: level.height as number,
              label: level.height ? `${level.height}p` : `Level ${i}`,
              bitrate: level.bitrate as number,
            }))
            .filter((q) => {
              if (seen.has(q.value)) return false
              seen.add(q.value)
              return true
            })
            .sort((a, b) => b.value - a.value)
          state.currentQuality = 'auto'
        })

        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
          if (generation !== loadGeneration) return
          // Only update displayed quality when ABR switches automatically
          if (state.currentQuality === 'auto') return
          const level = (hls.levels as any[])[data.level]
          if (level && level.height !== state.currentQuality) {
            // nextLevel has fully applied — confirm it
            state.currentQuality = level.height
          }
        })

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return
          // A fatal error from an abandoned stream must never surface on the
          // current source, nor clobber its loading state.
          if (generation !== loadGeneration) {
            destroyHls()
            return
          }
          const code = (data as any).response?.code ?? 0
          const isNotFound = code === 404
          state.error = {
            code,
            message: isNotFound
              ? 'Stream not found (404).'
              : 'Failed to load the stream. Check the URL or try again.',
            type: 'network',
          }
          state.isLoading = false
          state.isBuffering = false
          destroyHls()
        })

        // Guard one last time against a switch that happened between the
        // post-import check and instance construction.
        if (generation !== loadGeneration) {
          hls.destroy()
          return
        }

        hls.loadSource(src)
        hls.attachMedia(video)
        hlsInstance = hls
      } catch {
        if (generation !== loadGeneration) return
        state.error = { code: 0, message: 'Failed to initialize HLS player.', type: 'source' }
        state.isLoading = false
      }
    } else {
      // Registering the adapter before load() keeps the ownership chain
      // intact: a synchronous follow-up switch destroys it immediately.
      const adapter = createNativeAdapter(video)
      if (generation !== loadGeneration) {
        adapter.destroy()
        return
      }
      nativeAdapter = adapter
      nativeAdapter.load(src)
    }
  }

  function onFullscreenChange() {
    state.isFullscreen = !!document.fullscreenElement
  }

  function applyTrackModes(video: HTMLVideoElement) {
    const track = state.currentTrack
    Array.from(video.querySelectorAll<HTMLTrackElement>('track')).forEach((el) => {
      const t = el.track
      if (!t) return
      const isActive = track !== null && t.language === track.language && t.label === track.label
      t.mode = isActive ? 'hidden' : 'disabled'
    })
  }

  function attachListeners(video: HTMLVideoElement) {
    video.addEventListener('loadstart', () => {
      state.isLoading = true
      state.error = null
    })
    video.addEventListener('loadedmetadata', () => {
      syncFromVideo(video)
    })
    video.addEventListener('canplay', () => {
      state.isLoading = false
    })
    video.addEventListener('waiting', () => {
      state.isBuffering = true
    })
    video.addEventListener('playing', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('play', () => syncFromVideo(video))
    video.addEventListener('pause', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('ended', () => syncFromVideo(video))
    video.addEventListener('timeupdate', () => syncFromVideo(video))
    video.addEventListener('volumechange', () => syncFromVideo(video))
    video.addEventListener('durationchange', () => syncFromVideo(video))
    video.addEventListener('progress', () => syncFromVideo(video))
    video.addEventListener('ratechange', () => {
      state.playbackRate = video.playbackRate
    })
    video.addEventListener('error', () => {
      const err = video.error
      if (!err) return
      const typeMap: Record<number, PlayerError['type']> = {
        [MediaError.MEDIA_ERR_NETWORK]: 'network',
        [MediaError.MEDIA_ERR_DECODE]: 'decode',
        [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'source',
      }
      state.error = {
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message ?? 'Unknown playback error.',
        type: typeMap[err.code] ?? 'unknown',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    video.addEventListener('enterpictureinpicture', () => {
      state.isPiP = true
    })
    video.addEventListener('leavepictureinpicture', () => {
      state.isPiP = false
    })

    // Fullscreen must be observed on document — the player element is not <video>
    document.addEventListener('fullscreenchange', onFullscreenChange)
  }

  const controls: PlayerControls = {
    async play() {
      await videoRef.value?.play()
    },
    pause() {
      videoRef.value?.pause()
    },
    seek(seconds) {
      const video = videoRef.value
      if (!video || !state.duration) return
      video.currentTime = Math.max(0, Math.min(state.duration, seconds))
    },
    setVolume(value) {
      const video = videoRef.value
      if (!video) return
      video.volume = Math.max(0, Math.min(1, value))
      if (video.muted && value > 0) video.muted = false
    },
    toggleMute() {
      if (videoRef.value) videoRef.value.muted = !videoRef.value.muted
    },
    setSpeed(rate) {
      if (videoRef.value) videoRef.value.playbackRate = rate
    },
    setQuality(value) {
      if (!hlsInstance) return
      if (value === 'auto') {
        hlsInstance.currentLevel = -1 // -1 re-enables ABR
      } else {
        const idx = (hlsInstance.levels as any[]).findIndex((l) => l.height === value)
        // nextLevel switches at the next segment boundary — no buffer flush, no freeze
        if (idx !== -1) hlsInstance.nextLevel = idx
      }
      state.currentQuality = value
    },
    setTrack(track) {
      state.currentTrack = track
      const video = videoRef.value
      if (video) applyTrackModes(video)
    },
    async toggleFullscreen() {
      const video = videoRef.value
      const el = video?.closest<HTMLElement>('.vp-player')
      if (!el) return
      if (getFullscreenElement()) {
        await exitFullscreen()
      } else if ('requestFullscreen' in el || 'webkitRequestFullscreen' in el) {
        await enterFullscreen(el)
      } else {
        // iOS Safari: only supports fullscreen on the video element itself
        const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
        iosVideo.webkitEnterFullscreen?.()
      }
    },
    async togglePiP() {
      const video = videoRef.value
      if (!video) return
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    },
    retry() {
      if (lastSrc) loadSource(lastSrc)
    },
  }

  onMounted(() => {
    const video = videoRef.value
    if (!video) return
    attachListeners(video)
    syncFromVideo(video)
  })

  onUnmounted(() => {
    // Invalidates every in-flight generation so late async continuations no-op.
    loadGeneration++
    destroyAdapters()
    document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  return { state: readonly(state), controls, loadSource }
}
