/*
 * 本地验证样例（无浏览器、无第三方依赖）：
 *   node test/playerCore.test.js   或   npm test
 *
 * 用 Mock 的 video/canvas/logo/rAF 驱动 src/playerCore.js 状态机，覆盖四种情形：
 *   1. 正常连播：片段自动接续、旧链路回收、logo 替换、播完进入 ENDED、可重播
 *   2. 拖动跳转：旧轮询/旧视频/预加载被清理，目标片段按偏移重建，进度不越界
 *   3. 关闭释放：destroy 后无轮询、无存活视频、无残留 logo，方法全部 no-op
 *   4. 非法片段：end <= start / 非数字的片段被跳过，总时长与进度条一致
 */
const {
  MashupPlayerCore,
  PlayerState,
  normalizeSegments,
} = require('../src/playerCore')

// ---------- Mock 环境 ----------

function mockVideo(muted) {
  return {
    muted: !!muted,
    paused: true,
    currentTime: 0,
    src: '',
    ended: false,
    removed: false,
    playCount: 0,
    loadCount: 0,
    play() {
      this.playCount++
      this.paused = false
      return Promise.resolve()
    },
    pause() {
      this.paused = true
    },
    load() {
      this.loadCount++
    },
    removeAttribute() {
      this.src = ''
    },
    fireMetadata() {
      if (this.onloadedmetadata) this.onloadedmetadata()
    },
    fireSeeked() {
      if (this.onseeked) this.onseeked()
    },
    fireTimeUpdate() {
      if (this.ontimeupdate) this.ontimeupdate()
    },
  }
}

function mockEnv() {
  const frames = new Map()
  let nextId = 0
  const ctx = { drawCount: 0, drawImage() { this.drawCount++ } }
  const env = {
    videos: [],
    logos: [],
    canvases: [],
    ctx,
    createVideo(muted) {
      const v = mockVideo(muted)
      env.videos.push(v)
      return v
    },
    createCanvas() {
      const c = {
        width: 0,
        height: 0,
        removed: false,
        getContext: () => ctx,
      }
      env.canvases.push(c)
      return c
    },
    createLogo() {
      const l = { style: {}, src: '', removed: false }
      env.logos.push(l)
      return l
    },
    removeNode(n) {
      n.removed = true
    },
    requestFrame(cb) {
      const id = ++nextId
      frames.set(id, cb)
      return id
    },
    cancelFrame(id) {
      frames.delete(id)
    },
    // 执行一帧（模拟浏览器 rAF 心跳）
    runFrame() {
      const cbs = Array.from(frames.values())
      frames.clear()
      cbs.forEach((cb) => cb())
    },
    pendingFrames: () => frames.size,
  }
  return env
}

function seg(url, start, end, extra) {
  return Object.assign(
    {
      url,
      width: 1080,
      height: 1920,
      logoPosition: { x: 'left', y: 'top' },
      playPoint: { start: String(start), end: String(end) },
    },
    extra || {}
  )
}

/** 播放并让当前主视频完成 metadata + seek，进入真正播放 */
function startCurrentVideo(core) {
  const v = core._video // 当前在播视频（预加载是另一个元素，不能混淆）
  v.fireMetadata()
  v.fireSeeked()
  return v
}

// ---------- 测试框架 ----------

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}
function section(name) {
  console.log(`\n■ ${name}`)
}

// ---------- 情形一：正常连播 ----------

section('情形一：正常连播（含暂停/继续/播完重播）')
{
  const env = mockEnv()
  const states = []
  const core = new MashupPlayerCore({
    list: [
      seg('a.mp4', 0, 3, { logoPosition: { x: 'left', y: 'top' } }),
      seg('b.mp4', 4, 10, { logoPosition: { x: 'right', y: 'bottom' } }),
    ],
    logo: 'logo.png',
    env,
    onStateChange: (s) => states.push(s),
  })

  assert(core.totalTime === 9, `总时长为两片段时间之和 9s（实际 ${core.totalTime}）`)
  assert(
    JSON.stringify(core.skipDict) === JSON.stringify([3, 9]),
    'skipDict 累计节点为 [3, 9]'
  )

  core.play()
  assert(core.state === PlayerState.PLAYING, 'play() 后进入 PLAYING')
  assert(env.videos.length === 2, '创建主视频 + 下一片段预加载，共 2 个 video')
  assert(env.videos[1].muted === true, '预加载视频静音')
  assert(env.videos[1].playCount === 0, '预加载视频未 play()，不抢跑出声')
  assert(env.videos[1].src === 'b.mp4', '预加载的是下一片段')

  const v1 = startCurrentVideo(core, env)
  assert(v1.paused === false, '主视频在播')
  assert(env.logos.length === 1 && env.logos[0].src === 'logo.png', 'logo 已挂载')
  assert(env.logos[0].style.left !== undefined, '片段一 logo 在左侧')

  // 播放推进
  v1.currentTime = 1.5
  env.runFrame()
  assert(core.playedTime === 1.5, `进度推进到 1.5s（实际 ${core.playedTime}）`)
  const drawsBefore = env.ctx.drawCount
  env.runFrame()
  assert(
    env.ctx.drawCount === drawsBefore + 1,
    '每帧只绘制一次（任一时刻只有一个轮询）'
  )

  // 暂停 / 继续
  core.pause()
  assert(core.state === PlayerState.PAUSED && v1.paused, '暂停后视频暂停')
  const drawsAtPause = env.ctx.drawCount
  env.runFrame()
  assert(env.ctx.drawCount === drawsAtPause, '暂停时轮询不再绘制')
  core.resume()
  assert(core.state === PlayerState.PLAYING && !v1.paused, '继续后恢复播放')

  // 片段一播完 → 自动接续片段二
  v1.currentTime = 3.2
  env.runFrame()
  assert(core.playIndex === 1, '自动切到片段二')
  assert(v1.paused === true && v1.removed === true, '旧视频已暂停并释放')
  assert(env.videos[0].loadCount > 0, '旧视频 load() 释放解码资源')
  assert(env.videos[1].removed === true, '旧预加载对象已回收')
  assert(env.logos[0].removed === true, '旧 logo 已移除，无残留')
  assert(env.logos.length === 2 && env.logos[1].style.right !== undefined,
    '片段二 logo 按新位置（右侧）重建')
  assert(env.videos.length === 3, '最后一片段不再创建预加载')

  const v2 = startCurrentVideo(core, env)
  assert(v2.src === 'b.mp4' && v2.currentTime === 4, '片段二从 start=4s 起播')
  v2.currentTime = 6
  env.runFrame()
  assert(core.playedTime === 5, `进度跨片段累计为 5s（实际 ${core.playedTime}）`)

  // 全部播完
  v2.currentTime = 10.5
  env.runFrame()
  assert(core.state === PlayerState.ENDED, '播完进入 ENDED')
  assert(core.playedTime === 9, '播完进度等于总时长，不越界')
  assert(env.pendingFrames() === 0, '播完后无轮询存活')
  assert(env.videos.every((v) => v.paused && v.removed), '所有视频均已释放')

  // 播完重播：走同一套重建逻辑
  core.toggle()
  assert(core.state === PlayerState.PLAYING && core.playIndex === 0, 'toggle 触发重播')
  assert(core.playedTime === 0, '重播进度归零')
  const v3 = core._video
  assert(v3.src === 'a.mp4' && !v3.removed, '重播重建了片段一视频')
  core.destroy()
}

// ---------- 情形二：拖动跳转 ----------

section('情形二：拖动跳转')
{
  const env = mockEnv()
  const core = new MashupPlayerCore({
    list: [seg('a.mp4', 0, 3), seg('b.mp4', 4, 10), seg('c.mp4', 20, 25)],
    logo: 'logo.png',
    env,
  })
  core.play()
  const v1 = startCurrentVideo(core, env)
  v1.currentTime = 1
  env.runFrame()

  // 跳到片段三的中部：全局 11s → 片段三内偏移 11 - (3+6) = 2s
  core.seekTo(11)
  assert(core.playIndex === 2, '跳转定位到片段三')
  assert(v1.paused && v1.removed, '旧视频已暂停并释放')
  assert(env.pendingFrames() <= 1, '旧轮询已取消，最多一个新轮询')
  const vSeek = startCurrentVideo(core, env)
  assert(vSeek.src === 'c.mp4', '新视频为目标片段')
  assert(
    vSeek.currentTime === 22,
    `片内偏移正确：start 20 + 2 = 22s（实际 ${vSeek.currentTime}）`
  )
  vSeek.currentTime = 23
  const drawsBefore = env.ctx.drawCount
  env.runFrame()
  assert(env.ctx.drawCount === drawsBefore + 1, '跳转后仍只有一个轮询在绘制')
  assert(core.playedTime === 12, `进度 = 9 + 3 = 12s（实际 ${core.playedTime}）`)

  // 连续快速跳转：每次都先清理再重建
  core.seekTo(0.5)
  core.seekTo(4)
  const vFinal = startCurrentVideo(core, env)
  assert(core.playIndex === 1 && vFinal.src === 'b.mp4', '连续跳转后定位到最后目标')
  assert(
    env.videos.filter((v) => !v.paused).length <= 1,
    '连续跳转后最多一个在播视频'
  )
  const draws2 = env.ctx.drawCount
  env.runFrame()
  assert(env.ctx.drawCount === draws2 + 1, '连续跳转后依旧单轮询')

  // 进度越界钳制
  core.seekTo(-5)
  assert(core.playedTime === 0 && core.playIndex === 0, '负值钳制到 0')
  core.seekTo(99999)
  assert(core.state === PlayerState.ENDED, '超过总时长进入 ENDED')
  assert(core.playedTime === core.totalTime, '进度钳制到总时长，不越界')
  assert(env.pendingFrames() === 0, '跳到末尾后无轮询存活')
  core.destroy()
}

// ---------- 情形三：关闭释放 ----------

section('情形三：关闭释放')
{
  const env = mockEnv()
  const core = new MashupPlayerCore({
    list: [seg('a.mp4', 0, 3), seg('b.mp4', 4, 10)],
    logo: 'logo.png',
    env,
  })
  core.play()
  const v1 = startCurrentVideo(core, env)
  v1.currentTime = 1
  env.runFrame()
  assert(env.pendingFrames() === 1, '播放中有一个轮询')

  core.destroy()
  assert(core.state === PlayerState.DESTROYED, 'destroy 后进入 DESTROYED')
  assert(env.pendingFrames() === 0, '轮询已取消')
  assert(v1.paused && v1.removed, '在播视频已暂停并释放')
  assert(env.videos.every((v) => v.removed), '预加载视频也已释放')
  assert(env.logos.every((l) => l.removed), 'logo 已移除')
  assert(env.canvases.every((c) => c.removed), 'canvas 已移除')

  // 残留回调不得复活任何绘制
  const draws = env.ctx.drawCount
  env.runFrame()
  v1.fireTimeUpdate && v1.fireTimeUpdate()
  assert(env.ctx.drawCount === draws, 'destroy 后旧回调不再绘制')
  assert(env.pendingFrames() === 0, 'destroy 后不会再调度新帧')

  // 销毁后所有方法 no-op
  core.play()
  core.seekTo(1)
  core.toggle()
  core.resume()
  assert(env.pendingFrames() === 0, '销毁后 play/seek/toggle 均无效')
  assert(env.videos.every((v) => v.removed), '销毁后不再创建新视频')
  core.destroy() // 幂等
  assert(true, '重复 destroy 安全（幂等）')
}

// ---------- 情形四：非法片段 ----------

section('情形四：非法片段')
{
  const list = [
    seg('ok1.mp4', 0, 3),
    seg('bad-equal.mp4', 5, 5), // end == start
    seg('bad-reversed.mp4', 8, 2), // end < start
    seg('bad-nan.mp4', 'abc', 9), // 非数字
    seg('ok2.mp4', 10, 14),
  ]
  const segments = normalizeSegments(list)
  assert(segments.length === 2, `非法片段被跳过，剩 2 段（实际 ${segments.length}）`)
  assert(
    segments[0].url === 'ok1.mp4' && segments[1].url === 'ok2.mp4',
    '保留的均为合法片段'
  )

  const env = mockEnv()
  const core = new MashupPlayerCore({ list, logo: 'logo.png', env })
  assert(core.totalTime === 7, `总时长只计合法片段 = 7s（实际 ${core.totalTime}）`)
  assert(
    JSON.stringify(core.skipDict) === JSON.stringify([3, 7]),
    '进度条节点与总时长一致 [3, 7]'
  )

  core.play()
  const v1 = startCurrentVideo(core, env)
  assert(v1.src === 'ok1.mp4', '从第一个合法片段起播')
  v1.currentTime = 3.5 // 播完片段一
  env.runFrame()
  const v2 = startCurrentVideo(core, env)
  assert(v2.src === 'ok2.mp4', '非法片段不参与连播，直接接续 ok2')
  v2.currentTime = 100 // 远超过 end，进度也不得越界
  v2.fireTimeUpdate()
  assert(core.playedTime <= core.totalTime, '进度被钳制在总时长内')
  env.runFrame()
  assert(core.state === PlayerState.ENDED, '合法片段播完正常结束')
  assert(core.playedTime === 7, '结束时进度等于总时长 7s')

  // 全部非法：不创建任何视频，直接 ENDED
  const env2 = mockEnv()
  const core2 = new MashupPlayerCore({
    list: [seg('bad.mp4', 5, 5)],
    env: env2,
  })
  core2.play()
  assert(core2.totalTime === 0 && core2.state === PlayerState.ENDED, '无合法片段直接结束')
  assert(env2.videos.length === 0 && env2.pendingFrames() === 0, '无视频、无轮询')
  core.destroy()
  core2.destroy()
}

// ---------- 汇总 ----------

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
