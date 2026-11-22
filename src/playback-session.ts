/**
 * 播放会话：把「src 变化 → 拆除上一轮 → 建立新一轮」抽成可独立回归的逻辑，
 * 不依赖真实 WebView 或真实网络。
 *
 * 每一轮都拿到一个自增的 `id`。所有异步回包（清单请求、hls.js 动态加载）都先比对
 * `current === id`，不相等就直接丢弃；因此上一集的迟到回包不会挂到新视频上。
 */
import type Hls from "hls.js";
import {
  createPlaylistLoader, playerLoader, primeManifest, releasePrime, type HlsModule,
} from "./playback-source";

export type MediaTarget = {
  /** 交给 `<video src>` 或 `hls.loadSource` 的地址。 */
  url: string;
  /** 是否走 hls.js（m3u8 代理地址）。 */
  hls: boolean;
};

export type SessionHooks = {
  /** 增强缓冲：影响 hls.js 的缓冲上限。 */
  enhancedBuffer?: () => boolean;
  /** 每轮 hls.js 实例创建后调用，用于绑定 MANIFEST_PARSED 等事件。 */
  onHls?: (hls: Hls, Events: HlsModule["Events"]) => void;
  onError: (message: string) => void;
  /** 非 HLS 媒体：直接交给媒体元素。 */
  onNative: (url: string) => void;
};

/** 供回归替换：默认动态加载真实 hls.js。 */
export const setPlayerLoader = (load: (() => Promise<HlsModule>) | null) => {
  playerLoader.load = load ?? (() => import("hls.js"));
};

/** hls.js 只加载一次，之后每一轮直接复用模块。 */
let moduleCache: Promise<HlsModule> | null = null;
const hlsModule = () => (moduleCache ??= playerLoader.load());

export class PlayerSession {
  /** 当前轮次；每次 open/close 都会自增。 */
  private round = 0;
  private hls: Hls | null = null;
  private hooks: SessionHooks | null = null;
  /** 本轮预取但尚未被 hls.js 取走的地址，拆除时丢弃。 */
  private primed: (() => void) | null = null;

  /** 当前活动的 hls.js 实例；没有就是 null。 */
  get instance() {
    return this.hls;
  }

  /** 开始新一轮：上一轮的 hls.js 先被同步销毁，再按新地址建立。 */
  open(target: MediaTarget, hooks: SessionHooks, video: HTMLVideoElement | null): number {
    this.close();
    this.hooks = hooks;
    const id = this.round;
    if (!target.hls) {
      hooks.onNative(target.url);
      return id;
    }
    // 预取清单：并发打开同一地址只发一次请求，也能在创建 hls.js 前暴露明显的错误。
    // 取到的结果会被 hls.js 的清单加载器一次取走，因此正常播放仍只下载一次。
    const url = target.url;
    void primeManifest(url)
      .then(() => hlsModule())
      .then((module) => {
        if (this.round !== id || !this.hooks) return;
        this.attach(module, url, video, id);
      })
      .catch((error: unknown) => {
        if (this.round !== id || !this.hooks) return;
        const text = error instanceof Error ? error.message : "";
        if (text.startsWith("播放清单请求失败")) {
          // Network/HTTP failure of the manifest itself: keep the upstream status visible.
          this.hooks.onError(`播放清单加载失败 · ${text.replace(/^播放清单请求失败\s*/, "")}`);
        } else if (text.startsWith("响应不是")) {
          this.hooks.onError("播放清单加载失败 · 响应不是 HLS 播放列表");
        } else {
          this.hooks.onError("播放器组件加载失败，请重试");
        }
      });
    // 已取走时这里是空操作；没取走就随本轮一起丢弃。
    this.primed = () => releasePrime(url);
    return id;
  }

  /** 拆除当前轮：作废在途回包、丢弃未取走的预取并销毁 hls.js。 */
  close() {
    this.round += 1;
    this.hooks = null;
    this.primed?.();
    this.primed = null;
    this.hls?.destroy();
    this.hls = null;
  }

  private attach(module: HlsModule, url: string, video: HTMLVideoElement | null, id: number) {
    const Hls = module.default;
    const hooks = this.hooks;
    if (!hooks) return;
    if (!video || !Hls.isSupported()) {
      if (video) hooks.onNative(url);
      return;
    }
    const enhanced = hooks.enhancedBuffer?.() !== false;
    const hls = new Hls({
      interstitialsController: undefined, contentSteeringController: undefined, enableInterstitialPlayback: false,
      enableWorker: true, maxBufferLength: enhanced ? 60 : 20, maxMaxBufferLength: 90,
      maxBufferSize: (enhanced ? 32 : 20) * 1024 * 1024, backBufferLength: 15,
      manifestLoadingTimeOut: 15000, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3,
      pLoader: createPlaylistLoader(module),
    });
    // 迟到的实例不能覆盖已经前进的轮次。
    if (this.round !== id) { hls.destroy(); return; }
    this.hls = hls;
    hls.on(Hls.Events.ERROR, (_event, error) => {
      if (error.fatal && this.round === id) hooks.onError(`播放中断 · ${error.details}`);
    });
    hooks.onHls?.(hls, module.Events);
    hls.loadSource(url);
    hls.attachMedia(video);
  }
}
