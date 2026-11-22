/**
 * 播放清单的装载层。
 *
 * 换集/换线时同一个清单地址可能被多个播放器实例同时打开（预挂载下一集、旧实例尚未
 * 销毁、按钮连点）。这里把并发请求合并成一次：这些调用方共享同一个回包；请求结束后
 * 记录立即释放，之后的新请求会重新取一次，避免把签名过期或属于上一集的清单复用出去。
 */
import type {
  HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderStats, PlaylistLoaderContext,
} from "hls.js";

/** 已发出、尚未完成的清单请求；键是完整代理地址。 */
const inflight = new Map<string, Promise<string>>();

/**
 * 预取的清单，等待 hls.js 的清单加载器一次性取走。
 *
 * 播放会话在创建 hls.js 之前先取一次清单，好让「不是 m3u8」「HTTP 502」这类错误在
 * 播放器建立之前就暴露出来；随后 hls.js 请求同一地址时直接交回这份结果，避免每个
 * 分集都发两次请求。条目只能被取走一次。
 */
const primed = new Map<string, Promise<string>>();

/** 清单请求的默认超时，与 hls.js 的 manifestLoadingTimeOut 对齐。 */
const DEFAULT_TIMEOUT_MS = 15_000;

export type HlsModule = typeof import("hls.js");

/** 播放器引擎加载器（单独导出，便于回归替换为可控实现）。 */
export const playerLoader = {
  load: (): Promise<HlsModule> => import("hls.js"),
};

/** 经本地媒体协议改写的清单地址。 */
export const isProxiedPlaylist = (url: string) => url.includes("/hls?u=") || url.includes("/seg?u=");

async function fetchManifest(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`播放清单请求失败 (HTTP ${response.status})`);
  const text = await response.text();
  if (!text.replace(/^\u{feff}/u, "").trimStart().startsWith("#EXTM3U")) {
    throw new Error("响应不是 HLS 播放列表");
  }
  return text;
}

/**
 * 取一份 HLS 清单文本。相同地址的并发调用共享同一个请求与回包。
 *
 * 不用 `AbortController`：合并后的请求可能仍被其他播放器使用，单个调用方退出只应
 * 忽略结果，不应打断别人。
 */
export function loadManifest(url: string): Promise<string> {
  // hls.js 首次请求：交回预取结果，不重复下载。
  const ready = primed.get(url);
  if (ready) {
    primed.delete(url);
    return ready;
  }
  const existing = inflight.get(url);
  if (existing) return existing;
  const request = fetchManifest(url);
  inflight.set(url, request);
  const settle = () => {
    if (inflight.get(url) === request) inflight.delete(url);
  };
  request.then(settle, settle);
  return request;
}

/**
 * 预取一份清单，并让同一地址的第一次 [`loadManifest`] 直接复用它。
 * 失败时不会留下条目，下一次仍会重新请求。
 */
export function primeManifest(url: string): Promise<string> {
  const existing = inflight.get(url);
  if (existing) {
    primed.set(url, existing);
    return existing;
  }
  const request = fetchManifest(url);
  inflight.set(url, request);
  primed.set(url, request);
  const settle = () => {
    if (inflight.get(url) === request) inflight.delete(url);
  };
  request.then(settle, settle);
  // 失败或没人取走时都不要留下一个过期的结果。
  request.catch(() => {
    if (primed.get(url) === request) primed.delete(url);
  });
  return request;
}

/** 丢弃尚未被取走的预取结果（换集后旧清单不再需要）。 */
export function releasePrime(url: string) {
  primed.delete(url);
}

/** 仅用于回归：当前等待中的清单请求数。 */
export const pendingManifests = () => inflight.size;

/** 仅用于回归：尚未被取走的预取结果数。 */
export const pendingPrimes = () => primed.size;

function emptyStats(Stats: HlsModule["LoadStats"]): LoaderStats {
  const stats = new Stats();
  const now = performance.now();
  stats.loaded = 0;
  stats.total = 0;
  stats.aborted = false;
  stats.retry = 0;
  stats.chunkCount = 0;
  stats.bwEstimate = 0;
  stats.loading.start = now;
  stats.loading.first = 0;
  stats.loading.end = 0;
  stats.parsing.start = 0;
  stats.parsing.end = 0;
  stats.buffering.start = 0;
  stats.buffering.first = 0;
  stats.buffering.end = 0;
  return stats;
}

/**
 * 构造 hls.js 的清单加载器（`config.pLoader`）。
 *
 * 清单（主清单、子清单、音频/字幕清单）都经过 [`loadManifest`]，同一 src 的并发打开
 * 只产生一次网络请求；分片与密钥仍走 hls.js 自带加载器。
 */
export function createPlaylistLoader(module: HlsModule) {
  const Base = module.default.DefaultConfig.loader as unknown as
    new (config: HlsConfig) => Loader<PlaylistLoaderContext>;
  const Stats = module.LoadStats;

  return class SharedPlaylistLoader implements Loader<PlaylistLoaderContext> {
    private inner: Loader<PlaylistLoaderContext>;
    private currentStats: LoaderStats;
    private token = 0;
    private timer: number | undefined;
    context: PlaylistLoaderContext | null = null;

    constructor(config: HlsConfig) {
      this.inner = new Base(config);
      this.currentStats = emptyStats(Stats);
      this.context = null;
    }

    get stats(): LoaderStats {
      return this.currentStats;
    }

    destroy() {
      this.abort();
      this.inner.destroy();
    }

    /** 只作废本加载器的在途回调；不改动共享的清单请求。 */
    abort() {
      this.token += 1;
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }

    load(
      context: PlaylistLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<PlaylistLoaderContext>,
    ) {
      this.context = context;
      if (!isProxiedPlaylist(context.url)) {
        this.inner.load(context, config, callbacks);
        return;
      }
      const token = ++this.token;
      window.clearTimeout(this.timer);
      const stats = emptyStats(Stats);
      this.currentStats = stats;
      const requested = Number(
        config.timeout ?? config.loadPolicy?.maxLoadTimeMs ?? DEFAULT_TIMEOUT_MS,
      );
      const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
      this.timer = window.setTimeout(() => {
        if (token !== this.token) return;
        stats.aborted = true;
        callbacks.onTimeout(stats, context, null);
      }, limit);

      loadManifest(context.url).then(
        (text) => {
          if (token !== this.token) return;
          window.clearTimeout(this.timer);
          const now = performance.now();
          stats.loaded = stats.total = text.length;
          stats.loading.first = now;
          stats.loading.end = now;
          callbacks.onSuccess({ url: context.url, data: text, code: 200 }, stats, context, null);
        },
        (error: unknown) => {
          if (token !== this.token) return;
          window.clearTimeout(this.timer);
          stats.loading.end = performance.now();
          callbacks.onError(
            { code: 0, text: error instanceof Error ? error.message : String(error) },
            context,
            null,
            stats,
          );
        },
      );
    }
  };
}
