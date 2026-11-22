<template>
  <div class="popup-layer">
    <div class="video-player-wrapper">
      <div id="VideoDom">
        <div id="canvasDom" @click="changeVideoState">
          <div v-show="showDom" id="progressBar" :class="[paused ? 'show' : '']" @click.stop>
            <div class="bar" @click.stop="skipLine">
              <div
                ref="trunk"
                class="line"
                :class="['progress', paused ? 'pause' : 'play', !drag ? 'trans' : '']"
                :style="{ width: `${progressPercent}%` }"
              ></div>
              <div
                id="circle"
                :class="{ trans: !drag }"
                @mousedown.stop="dragStart"
              ></div>
            </div>

            <div class="left-box">
              <div href="#" class="btn">
                <button
                  class="play"
                  :class="[paused ? 'play' : 'pause']"
                  @click.stop="changeVideoState"
                ></button>
              </div>
              <div class="total-time">{{ sToHs(playedTime) }} / {{ sToHs(totalTime) }}</div>
            </div>
            <div class="volume" @click.stop>
              <input type="checkbox" @click="changeVoiceStatus" />
              <svg viewBox="0 0 108 96">
                <path
                  d="M7,28 L35,28 L35,28 L59,8 L59,88 L35,68 L7,68 C4.790861,68 3,66.209139 3,64 L3,32 C3,29.790861 4.790861,28 7,28 Z"
                ></path>
                <path
                  d="M79,62 C83,57.3333333 85,52.6666667 85,48 C85,43.3333333 83,38.6666667 79,34 L49,3"
                ></path>
                <path
                  d="M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.666667,32.3333333 95,25 L75.5,6 L49,33"
                ></path>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
    <i class="popup-layer-btn-close" @click="close">x</i>
    <div v-show="!showDom" class="loadEffect">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <section v-show="paused" class="playContainer" @click="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script>
import { MashupPlayerCore, PlayerState, createBrowserEnv } from './playerCore'

export default {
  data() {
    return {
      list: [],
      logo: '',
      // 播放链路状态机（mounted 中创建）
      core: null,
      // 是否暂停
      paused: true,
      // 总时长
      totalTime: 0,
      // 当前播放时长
      playedTime: 0,
      // 是否正在拖动进度条
      drag: 0,
      // 是否展示进度条
      showDom: false,
      // 是否已清理（保证清理逻辑只跑一次）
      _cleaned: false,
    }
  },
  computed: {
    progressPercent() {
      if (!this.totalTime) return 0
      return Math.min(100, Math.max(0, (this.playedTime / this.totalTime) * 100))
    },
  },
  mounted() {
    const canvasHolder = this.$el.querySelector('#canvasDom')
    const videoHolder = this.$el.querySelector('#VideoDom')
    const env = createBrowserEnv(canvasHolder)
    // 根据父容器大小等比缩放画幅（contain）
    env.getCanvasSize = (segment) => {
      const pw = videoHolder ? videoHolder.clientWidth : 0
      const ph = videoHolder ? videoHolder.clientHeight : 0
      if (!pw || !ph || !segment.width || !segment.height) {
        return { width: segment.width, height: segment.height }
      }
      const scale = Math.max(segment.width / pw, segment.height / ph)
      return { width: segment.width / scale, height: segment.height / scale }
    }
    this.core = new MashupPlayerCore({
      list: this.list,
      logo: this.logo,
      env,
      onProgress: (played, total) => {
        this.totalTime = total
        if (!this.drag) this.playedTime = played
      },
      onStateChange: (state) => {
        this.paused = state !== PlayerState.PLAYING
        if (state === PlayerState.PLAYING) this.showDom = true
      },
      onError: (err) => {
        console.warn('canvas-player:', err)
      },
    })
    this.totalTime = this.core.totalTime
    document.addEventListener('keydown', this.keydown)
    document.addEventListener('mousemove', this.mousemove)
    document.addEventListener('mouseup', this.mouseup)
    this.core.play()
  },
  beforeDestroy() {
    this._cleanup()
  },
  methods: {
    // 统一清理：状态机销毁 + 事件监听移除，关闭后不再有轮询或监听存活
    _cleanup() {
      if (this._cleaned) return
      this._cleaned = true
      document.removeEventListener('keydown', this.keydown)
      document.removeEventListener('mousemove', this.mousemove)
      document.removeEventListener('mouseup', this.mouseup)
      if (this.core) {
        this.core.destroy()
        this.core = null
      }
      if (typeof this.setFree === 'function') this.setFree()
    },
    close() {
      this._cleanup()
      try {
        if (typeof this.onClose === 'function') {
          this.onClose(this)
        }
      } catch (e) {
        console.log(e)
      }
      this.$destroy(true)
      if (this.$el && this.$el.parentNode) {
        this.$el.parentNode.removeChild(this.$el)
      }
    },
    keydown(e) {
      if (e.keyCode === 27) {
        // esc 关闭，走同一套清理逻辑
        this.close()
      }
    },
    // 播放 || 暂停 || 播完重播
    changeVideoState() {
      if (this.core) this.core.toggle()
    },
    // 静音
    changeVoiceStatus() {
      if (this.core) this.core.setMuted(!this.core.muted)
    },
    // 进度条拖动开始：先暂停，拖动过程中只更新本地进度显示
    dragStart(e) {
      e.preventDefault()
      this.drag = 1
      if (this.core) this.core.pause()
    },
    mousemove(e) {
      if (this.drag !== 1) return
      const bar = this.$el.querySelector('.bar')
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      if (!rect.width) return
      let rate = (e.clientX - rect.left) / rect.width
      rate = Math.min(1, Math.max(0, rate))
      this.playedTime = rate * this.totalTime
    },
    mouseup() {
      if (this.drag !== 1) return
      this.drag = 0
      // 拖动结束：与点击跳转走同一套 seekTo 清理 + 重建逻辑
      if (this.core) this.core.seekTo(this.playedTime)
    },
    // 点击进度条跳转
    skipLine(e) {
      const bar = this.$el.querySelector('.bar')
      if (!bar || !this.core) return
      const rect = bar.getBoundingClientRect()
      if (!rect.width) return
      let rate = (e.clientX - rect.left) / rect.width
      rate = Math.min(1, Math.max(0, rate))
      this.playedTime = rate * this.totalTime
      this.core.seekTo(this.playedTime)
    },
    sToHs(s) {
      s = parseFloat(s).toFixed(0)
      var h
      h = Math.floor(s / 60)
      s = s % 60
      h += ''
      s += ''
      h = h.length == 1 ? '0' + h : h
      s = s.length == 1 ? '0' + s : s
      return h + ':' + s
    },
  },
}
</script>
<style>
@import './style/style.css';
</style>
<style lang="less" scoped>
.popup-layer {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85);
  color: #fff;

  .video-player-wrapper {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .popup-layer-btn-close {
    position: absolute;
    right: 20px;
    top: 20px;
    width: 50px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    font-style: initial;
    font-size: 40px;
    line-height: 30px;
    cursor: pointer;
    padding: 6px 0 12px;
    border-radius: 100%;
    user-select: none;
    &:hover {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 1);
    }
  }
}

#VideoDom {
  position: relative;
  font-size: 0;
  line-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  #canvasDom {
    position: relative;
    #progressBar {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      bottom: 0;
      width: 100%;
      background: rgba(0, 0, 0, 0.521);
      z-index: 99;
      opacity: 0;
      transition: all 0.5s;
      .left-box {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 50%;
        .btn {
          height: 100%;
          color: #000;
          margin-right: 2px;
          background: transparent;
          border: none;
          button {
            margin: 10px;
            padding: 0;
            box-sizing: border-box;
            border: transparent;
            background: transparent;
            user-select: none;
            &.play {
              height: 20px;
              border-style: solid;
              outline: none;
              border-width: 10px 0 10px 18px;
              border-color: transparent transparent transparent #00a1d6;
              transition: all 0.1s linear;
            }
            &.pause {
              border-style: double;
              border-width: 0px 0px 0px 18px;
              border-color: #00a1d6;
            }
          }
        }
        .total-time {
          color: #e3e3e3;
          font-size: 15px;
          line-height: 100%;
          pointer-events: none;
          user-select: none;
        }
      }

      .bar {
        display: flex;
        align-items: center;
        margin: 10px auto 0;
        width: 98%;
        height: 7px;
        border-radius: 10px;
        background: #7171716e;
        transition: all 0.2s;
        cursor: pointer;
        .line {
          position: relative;
          width: 100%;
          height: 100%;
          background: #00a1d6;
          border-radius: 5px;
          animation-timing-function: linear;
          &.trans {
            transition: all 0.5s;
          }
          &.play {
            animation-play-state: running;
          }
          &.pause {
            animation-play-state: paused;
          }
        }
        #circle {
          position: relative;
          margin-left: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #fff;
          pointer-events: none;
          &.trans {
            pointer-events: auto;
            transition: all 0.5s;
          }
        }
      }

      &:hover {
        .bar {
          height: 13px;
          transition: all 0.2s;
          #circle {
            height: 14px;
            width: 14px;
          }
        }
      }
      &.show {
        opacity: 1;
      }
    }
    &:hover {
      #progressBar {
        opacity: 1;
        transition: all 1s;
      }
    }
  }
}
</style>
