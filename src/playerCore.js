/*
 * 播放链路状态机（框架无关，可独立测试）
 *
 * 不变式：
 *  - 任一时刻最多一个绘制轮询（requestFrame）和一个在播视频；
 *  - 换片 / 拖动 / 暂停继续 / 播完重播 / 关闭 都经过同一套
 *    _teardownSegment() 清理：取消轮询、暂停并释放旧视频与预加载对象、移除旧 logo；
 *  - 预加载只保留下一片段，始终静音、绝不 play()，不会抢跑出声；
 *  - destroy() 之后不再有任何轮询、定时器或事件回调存活。
 *
 * 该文件使用 CommonJS 导出，浏览器端经 babel/webpack 打包，
 * Node 端可直接 require 用于本地验证（见 test/playerCore.test.js）。
 */

const PlayerState = {
  IDLE: 'idle', // 尚未开始
  PLAYING: 'playing', // 播放中
  PAUSED: 'paused', // 暂停
  ENDED: 'ended', // 全部播完
  DESTROYED: 'destroyed', // 已销毁（终态，所有方法变为 no-op）
}

// logo 以 1080 宽画幅为基准换算
const LOGO_BASE_WIDTH = 1080
const LOGO_WIDTH = 150
const LOGO_OFFSET = 60

function noop() {}

function toTime(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : NaN
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max)
}

/**
 * 归一化片段列表：
 *  - start/end 解析为数字，非法（NaN）或 end <= start 的片段直接跳过；
 *  - start 负值按 0 处理。
 */
function normalizeSegments(list) {
  if (!Array.isArray(list)) return []
  const segments = []
  for (const item of list) {
    if (!item || !item.url || !item.playPoint) continue
    let start = toTime(item.playPoint.start)
    let end = toTime(item.playPoint.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 0) start = 0
    if (end <= start) continue // 非法片段：跳过
    const width = Number(item.width)
    const height = Number(item.height)
    segments.push({
      url: item.url,
      width: width > 0 ? width : LOGO_BASE_WIDTH,
      height: height > 0 ? height : 0,
      logoPosition: item.logoPosition || null,
      start,
      end,
      duration: end - start,
    })
  }
  return segments
}

/**
 * 浏览器环境适配器：core 只通过 env 接触 DOM，便于测试替换。
 * container：视频 / canvas / logo 的挂载点（通常是 #canvasDom）。
 */
function createBrowserEnv(container) {
  container = container || document.body
  return {
    createVideo(muted) {
      const v = document.createElement('video')
      v.preload = 'auto'
      v.muted = !!muted
      v.playsInline = true
      v.style.display = 'none'
      container.appendChild(v)
      return v
    },
    createCanvas() {
      const c = document.createElement('canvas')
      container.appendChild(c)
      return c
    },
    createLogo() {
      const img = document.createElement('img')
      container.appendChild(img)
      return img
    },
    removeNode(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node)
    },
    requestFrame(cb) {
      return window.requestAnimationFrame(cb)
    },
    cancelFrame(id) {
      window.cancelAnimationFrame(id)
    },
  }
}

class MashupPlayerCore {
  /**
   * @param {Object} options
   *  - list: 原始片段列表（含 playPoint.start/end）
   *  - logo: logo 图片地址（空则不显示）
   *  - env: { createVideo, createCanvas, createLogo, removeNode, requestFrame, cancelFrame, getCanvasSize? }
   *  - onProgress(playedTime, totalTime)
   *  - onStateChange(state)
   *  - onError(err)
   */
  constructor(options) {
    options = options || {}
    this.env = options.env || {}
    this.logo = options.logo || ''
    this.onProgress = options.onProgress || noop
    this.onStateChange = options.onStateChange || noop
    this.onError = options.onError || noop

    this.segments = normalizeSegments(options.list)
    // 时间段累计节点，进度条快速定位；总时长与进度条保持一致
    this.skipDict = []
    let total = 0
    for (const seg of this.segments) {
      total += seg.duration
      this.skipDict.push(total)
    }
    this.totalTime = total

    this.state = PlayerState.IDLE
    this.playIndex = 0
    this.playedTime = 0
    this.muted = false

    // 代际令牌：每次清理自增，所有旧回调据此失效，杜绝多个轮询同时绘制
    this._gen = 0
    this._frameId = null
    this._video = null // 当前在播视频（唯一）
    this._preloadVideo = null // 预加载视频（仅下一片段，静音）
    this._logoEl = null
    this._canvas = null
    this._ctx = null
    this._canvasSize = null
  }

  // ---------- 公开 API ----------

  /** 从头开始播放 */
  play() {
    if (this.state === PlayerState.DESTROYED) return
    this.playedTime = 0
    this._emitProgress()
    this._playSegment(0, 0)
  }

  /** 暂停（仅播放中有效） */
  pause() {
    if (this.state !== PlayerState.PLAYING) return
    this._cancelFrame()
    if (this._video) {
      try {
        this._video.pause()
      } catch (e) {
        /* noop */
      }
    }
    this._setState(PlayerState.PAUSED)
  }

  /** 继续（仅暂停时有效） */
  resume() {
    if (this.state !== PlayerState.PAUSED || !this._video) return
    this._setState(PlayerState.PLAYING)
    const p = this._safePlay(this._video)
    if (p && p.catch) p.catch((err) => this.onError(err))
    this._scheduleDraw(this._gen)
  }

  /** 播放/暂停切换；播完后再触发视为重播 */
  toggle() {
    if (this.state === PlayerState.PLAYING) {
      this.pause()
    } else if (this.state === PlayerState.PAUSED) {
      this.resume()
    } else if (this.state === PlayerState.ENDED || this.state === PlayerState.IDLE) {
      this.play() // 播完重播 / 首次播放，走同一套重建逻辑
    }
  }

  /**
   * 跳转到全局时间轴上的 time（秒）。
   * 进度越界会被钳制到 [0, totalTime]；跳到末尾直接进入 ENDED。
   * 跳转总是先清理旧链路再按目标片段重建，并继续播放。
   */
  seekTo(time) {
    if (this.state === PlayerState.DESTROYED) return
    if (!this.segments.length) {
      this.playedTime = 0
      this._emitProgress()
      return
    }
    time = clamp(Number(time) || 0, 0, this.totalTime)
    if (time >= this.totalTime) {
      // 拖到最末：清理后直接置为播完状态
      this._teardownSegment()
      this.playedTime = this.totalTime
      this._emitProgress()
      this._setState(PlayerState.ENDED)
      return
    }
    let index = 0
    for (let i = 0; i < this.skipDict.length; i++) {
      if (time < this.skipDict[i]) {
        index = i
        break
      }
    }
    const base = index > 0 ? this.skipDict[index - 1] : 0
    this.playedTime = time
    this._emitProgress()
    this._playSegment(index, time - base)
  }

  /** 静音开关（预加载视频不受影响，永远静音） */
  setMuted(muted) {
    this.muted = !!muted
    if (this._video) this._video.muted = this.muted
  }

  /** 销毁：取消轮询、释放视频/预加载/logo/canvas，之后所有方法 no-op */
  destroy() {
    if (this.state === PlayerState.DESTROYED) return
    this._teardownSegment()
    if (this._canvas) {
      this._removeNode(this._canvas)
      this._canvas = null
      this._ctx = null
    }
    this._canvasSize = null
    this._setState(PlayerState.DESTROYED)
  }

  // ---------- 内部：片段生命周期 ----------

  /** 播放第 index 个片段，offset 为片段内偏移（秒）。先清理、再重建。 */
  _playSegment(index, offset) {
    if (this.state === PlayerState.DESTROYED) return
    const segment = this.segments[index]
    if (!segment) {
      this._finish()
      return
    }
    // 一、统一清理：取消旧轮询、释放旧视频/预加载、移除旧 logo
    this._teardownSegment()
    this.playIndex = index
    offset = clamp(offset || 0, 0, segment.duration)
    const gen = this._gen

    // 二、按目标片段重建
    this._canvasSize = this._computeCanvasSize(segment)
    this._ensureCanvas()

    const video = this.env.createVideo(false)
    this._video = video
    video.muted = this.muted
    const startAt = segment.start + offset

    video.onloadedmetadata = () => {
      if (this._gen !== gen || this._video !== video) return
      try {
        video.currentTime = startAt
      } catch (e) {
        /* noop */
      }
    }
    video.onseeked = () => {
      if (this._gen !== gen || this._video !== video) return
      if (this.state !== PlayerState.PLAYING) return
      const p = this._safePlay(video)
      if (p && p.catch) p.catch((err) => this.onError(err))
    }
    video.ontimeupdate = () => {
      if (this._gen !== gen || this._video !== video) return
      this._syncProgress(video, segment, index)
      if (video.currentTime >= segment.end) this._onSegmentEnd(gen)
    }
    video.onended = () => {
      if (this._gen !== gen || this._video !== video) return
      this._onSegmentEnd(gen)
    }
    video.onerror = (err) => {
      if (this._gen !== gen || this._video !== video) return
      this.onError(err)
      this._onSegmentEnd(gen) // 坏片段不阻塞整体连播
    }
    video.src = segment.url

    this._setState(PlayerState.PLAYING)
    this._scheduleDraw(gen)
    this._applyLogo(segment)
    this._preloadNext(index + 1, gen)
  }

  /** 统一清理入口：取消轮询 + 释放在播视频 + 释放预加载 + 移除 logo */
  _teardownSegment() {
    this._gen += 1 // 使所有旧回调失效
    this._cancelFrame()
    this._releaseVideo()
    this._releasePreload()
    this._removeLogo()
  }

  _cancelFrame() {
    if (this._frameId != null) {
      try {
        this.env.cancelFrame(this._frameId)
      } catch (e) {
        /* noop */
      }
      this._frameId = null
    }
  }

  _releaseVideo() {
    const v = this._video
    if (!v) return
    this._video = null
    v.onloadedmetadata = null
    v.onseeked = null
    v.ontimeupdate = null
    v.onended = null
    v.onerror = null
    v.onplay = null
    try {
      v.pause()
    } catch (e) {
      /* noop */
    }
    try {
      v.removeAttribute('src')
    } catch (e) {
      /* noop */
    }
    try {
      v.load() // 释放解码器与网络连接
    } catch (e) {
      /* noop */
    }
    this._removeNode(v)
  }

  _releasePreload() {
    const v = this._preloadVideo
    if (!v) return
    this._preloadVideo = null
    v.onloadedmetadata = null
    try {
      v.pause()
    } catch (e) {
      /* noop */
    }
    try {
      v.removeAttribute('src')
    } catch (e) {
      /* noop */
    }
    try {
      v.load()
    } catch (e) {
      /* noop */
    }
    this._removeNode(v)
  }

  _removeLogo() {
    if (this._logoEl) {
      this._removeNode(this._logoEl)
      this._logoEl = null
    }
  }

  _removeNode(node) {
    if (this.env.removeNode) this.env.removeNode(node)
  }

  _safePlay(video) {
    try {
      return video.play()
    } catch (e) {
      this.onError(e)
      return null
    }
  }

  // ---------- 内部：绘制轮询 ----------

  _scheduleDraw(gen) {
    this._cancelFrame()
    this._frameId = this.env.requestFrame(() => this._drawLoop(gen))
  }

  _drawLoop(gen) {
    // 代际或状态不符：旧轮询立即退出，保证任一时刻只有一个轮询在绘制
    if (this._gen !== gen || this.state !== PlayerState.PLAYING) return
    const video = this._video
    const segment = this.segments[this.playIndex]
    if (!video || !segment) return
    if (video.ended || video.currentTime >= segment.end) {
      this._onSegmentEnd(gen)
      return
    }
    const canvas = this._canvas
    const size = this._canvasSize
    if (canvas && this._ctx && size && video.readyState !== 0) {
      // 尺寸切换发生在新片段首帧绘制前，旧画面保留到最后一刻，切换不黑屏
      if (canvas.width !== size.width) canvas.width = size.width
      if (canvas.height !== size.height) canvas.height = size.height
      try {
        this._ctx.drawImage(video, 0, 0, size.width, size.height)
      } catch (e) {
        /* noop */
      }
    }
    this._syncProgress(video, segment, this.playIndex)
    this._frameId = this.env.requestFrame(() => this._drawLoop(gen))
  }

  // ---------- 内部：进度与片段推进 ----------

  /** 进度 = 之前片段累计时长 + 当前片段已播时长，钳制在 [0, totalTime] */
  _syncProgress(video, segment, index) {
    const base = index > 0 ? this.skipDict[index - 1] : 0
    const t = clamp(base + (video.currentTime - segment.start), 0, this.totalTime)
    if (t !== this.playedTime) {
      this.playedTime = t
      this._emitProgress()
    }
  }

  _onSegmentEnd(gen) {
    if (this._gen !== gen || this.state !== PlayerState.PLAYING) return
    const next = this.playIndex + 1
    if (next < this.segments.length) {
      this._playSegment(next, 0)
    } else {
      this._finish()
    }
  }

  _finish() {
    this._teardownSegment()
    this.playedTime = this.totalTime
    this._emitProgress()
    this._setState(PlayerState.ENDED)
  }

  // ---------- 内部：预加载 / logo / canvas ----------

  /** 预加载仅保留下一片段；静音且绝不 play()，不会抢跑出声 */
  _preloadNext(nextIndex, gen) {
    const seg = this.segments[nextIndex]
    if (!seg || !this.env.createVideo) return
    const v = this.env.createVideo(true)
    v.muted = true
    v.preload = 'auto'
    v.onloadedmetadata = () => {
      if (this._gen !== gen || this._preloadVideo !== v) return
      try {
        v.currentTime = seg.start
      } catch (e) {
        /* noop */
      }
    }
    v.src = seg.url
    this._preloadVideo = v
  }

  /** logo 随片段切换整体替换：旧元素已移除，按当前片段画幅重新换算尺寸与位置 */
  _applyLogo(segment) {
    if (!this.logo || !segment.logoPosition || !this.env.createLogo) {
      this._logoEl = null
      return
    }
    const pos = segment.logoPosition
    const x = pos.x === 'left' ? 'left' : 'right'
    const y = pos.y === 'top' ? 'top' : 'bottom'
    const el = this.env.createLogo()
    const size = this._canvasSize || { width: segment.width }
    const ratio = size.width / (segment.width || LOGO_BASE_WIDTH)
    el.style.position = 'absolute'
    el.style.width = `${LOGO_WIDTH * ratio}px`
    el.style[x] = `${LOGO_OFFSET * ratio}px`
    el.style[y] = `${LOGO_OFFSET * ratio}px`
    el.src = this.logo
    this._logoEl = el
  }

  _ensureCanvas() {
    if (!this._canvas) {
      this._canvas = this.env.createCanvas()
      this._ctx = this._canvas.getContext('2d')
    }
    return this._canvas
  }

  _computeCanvasSize(segment) {
    if (typeof this.env.getCanvasSize === 'function') {
      const size = this.env.getCanvasSize(segment)
      if (size && size.width > 0 && size.height > 0) return size
    }
    return { width: segment.width, height: segment.height || segment.width }
  }

  // ---------- 内部：状态与事件 ----------

  _setState(state) {
    if (this.state === state) return
    this.state = state
    this.onStateChange(state)
  }

  _emitProgress() {
    this.onProgress(this.playedTime, this.totalTime)
  }
}

module.exports = {
  MashupPlayerCore,
  PlayerState,
  normalizeSegments,
  createBrowserEnv,
}
