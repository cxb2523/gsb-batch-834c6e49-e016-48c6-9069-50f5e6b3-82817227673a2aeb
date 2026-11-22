import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { LOCAL } from "../src/api";
import { PlayerSession, setPlayerLoader } from "../src/playback-session";
import {
  loadManifest, pendingManifests, pendingPrimes, primeManifest, type HlsModule,
} from "../src/playback-source";

/**
 * 换集/换线时的播放生命周期：旧实例拆除、旧回包丢弃、同地址并发合并。
 * 全部使用可控的假 hls.js 与假 fetch，不访问真实上游。
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const checks: string[] = [];
const assert = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label); };

/* ── 假 fetch：可手动完成的清单请求 ───────────────────────── */
type Pending = { url: string; resolve: (text: string) => void; reject: (error: Error) => void };
const pending: Pending[] = [];
let fetched = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  fetched += 1;
  return new Promise<Response>((resolve, reject) => pending.push({
    url,
    resolve: (text) => resolve(new Response(text, { status: 200 })),
    reject,
  }));
}) as typeof fetch;
const settle = async (index: number, text = "#EXTM3U\n#EXTINF:4,\nseg-1.ts\n") => {
  await act(async () => { pending[index].resolve(text); await Promise.resolve(); });
};
const failPending = async (index: number, message: string) => {
  await act(async () => { pending[index].reject(new Error(message)); await Promise.resolve(); });
};

/* ── 假 hls.js：记录创建/销毁与加载的地址 ─────────────────── */
const created: FakeHls[] = [];
class FakeHls {
  static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
  static DefaultConfig = {
    loader: class { destroy() {} load(_a: unknown, _b: unknown, _c: unknown) {} },
  };
  static isSupported() { return true; }
  static instances(): FakeHls[] { return created; }
  config: Record<string, unknown>;
  destroyed = false;
  source = "";
  attached: unknown = null;
  /** 模拟 hls.js 通过清单加载器取主清单：它会消费本地址的预取结果。 */
  manifest: { loaded: boolean; error: string | null } = { loaded: false, error: null };
  handlers = new Map<string, (event: string, data: unknown) => void>();
  constructor(config: Record<string, unknown>) { this.config = config; created.push(this); }
  on(event: string, handler: (event: string, data: unknown) => void) { this.handlers.set(event, handler); }
  loadSource(url: string) {
    this.source = url;
    const Loader = this.config.pLoader as new (config: unknown) => {
      load(context: unknown, config: unknown, callbacks: Record<string, (...args: unknown[]) => void>): void;
    };
    if (!Loader) return;
    const loader = new Loader(this.config);
    loader.load(
      { url, responseType: "text", type: "manifest", level: 0, id: null },
      { timeout: 15000, loadPolicy: { maxLoadTimeMs: 15000 } },
      {
        onSuccess: () => { this.manifest.loaded = true; },
        onError: (error: unknown) => { this.manifest.error = String((error as { text?: string }).text); },
        onTimeout: () => { this.manifest.error = "timeout"; },
      },
    );
  }
  attachMedia(media: unknown) { this.attached = media; }
  stopLoad() {}
  destroy() { this.destroyed = true; }
  emit(event: string, data: unknown = {}) { this.handlers.get(event)?.(event, data); }
}
class FakeLoadStats {
  loaded = 0; total = 0; aborted = false; retry = 0; chunkCount = 0; bwEstimate = 0;
  loading = { start: 0, first: 0, end: 0 }; parsing = { start: 0, end: 0 };
  buffering = { start: 0, first: 0, end: 0 };
}
const fakeModule = {
  default: FakeHls, LoadStats: FakeLoadStats,
  Events: FakeHls.Events, isSupported: () => true,
} as unknown as HlsModule;
setPlayerLoader(async () => fakeModule);

/* ── 假媒体元素：记录属性操作，便于断言解绑 ───────────────── */
const media = document.createElement("video");
let paused = true;
Object.defineProperties(media, {
  src: { configurable: true, get() { return (media as unknown as { _src?: string })._src ?? ""; }, set(value: string) { (media as unknown as { _src?: string })._src = value; } },
  pause: { configurable: true, value() { paused = true; } },
  load: { configurable: true, value() {} },
});
const removedSrcs: string[] = [];
const nativeRemove = media.removeAttribute.bind(media);
media.removeAttribute = (name: string) => { if (name === "src") removedSrcs.push(name); nativeRemove(name); };

const hooks = () => {
  const seen = { errors: [] as string[], natives: [] as string[], parsed: 0 };
  return {
    seen,
    hooks: {
      enhancedBuffer: () => true,
      onHls: (hls: { on(event: string, handler: () => void): void }) =>
        hls.on(FakeHls.Events.MANIFEST_PARSED, () => { seen.parsed += 1; }),
      onError: (message: string) => { seen.errors.push(message); },
      onNative: (url: string) => { seen.natives.push(url); },
    },
  };
};

const hlsUrl = (name: string) => `${LOCAL}/hls?u=${encodeURIComponent(`https://cdn.example/${name}.m3u8`)}`;

try {
  /* 1. 正常取址与清单装载：一轮只创建一个实例，并绑定正确的媒体元素。 */
  {
    const session = new PlayerSession();
    const { seen, hooks: bound } = hooks();
    const url = hlsUrl("episode-1");
    session.open({ url, hls: true }, bound, media);
    assert(pending.length === 1 && pending[0].url === url, "opening a playlist issues exactly one manifest request");
    const beforePlayback = fetched;
    await settle(0);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const [hls] = FakeHls.instances();
    assert(!!hls && !hls.destroyed, "a manifest opens one hls.js instance");
    assert(hls.source === url && hls.attached === media, "the instance loads that src onto the media element");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(hls.manifest.loaded && hls.manifest.error === null, "the player's manifest loader receives the playlist");
    assert(fetched === beforePlayback, "the prefetched manifest is handed to hls.js rather than downloaded twice");
    assert(pendingPrimes() === 0, "the prefetched manifest is consumed by the player");
    assert(seen.parsed === 0, "MANIFEST_PARSED has not fired yet");
    hls.emit(FakeHls.Events.MANIFEST_PARSED);
    assert(seen.parsed === 1, "MANIFEST_PARSED reaches the caller once");
    assert(pendingManifests() === 0, "a settled manifest leaves no pending entry to be reused");
    session.close();
    assert(hls.destroyed, "closing a session destroys the instance");
  }

  /* 2. 同地址并发只发一次请求。 */
  {
    const first = loadManifest(hlsUrl("shared"));
    const second = loadManifest(hlsUrl("shared"));
    const third = loadManifest(hlsUrl("shared"));
    const before = fetched;
    assert(pending.length >= 1, "a manifest request is in flight");
    await settle(pending.length - 1);
    const [a, b, c] = await Promise.all([first, second, third]);
    assert(a === b && b === c, "concurrent loads of one src share a single response");
    assert(fetched === before, "the shared src was fetched only once");
    assert(pendingManifests() === 0, "the shared entry is released after settling");
    const again = loadManifest(hlsUrl("shared"));
    assert(fetched === before + 1, "a later request fetches again instead of reusing a stale manifest");
    await settle(pending.length - 1);
    await again;
  }

  /* 2b. 预取结果只被 hls.js 取走一次，不会被重新下载或长期滞留。 */
  {
    const url = hlsUrl("primed");
    const before = fetched;
    const prefetch = primeManifest(url);
    assert(pending.length >= 1 && pendingPrimes() === 1, "the prefetch waits once and is handed to hls.js later");
    await settle(pending.length - 1);
    await prefetch;
    const consumed = loadManifest(url);
    assert(fetched === before + 1, "the loader consumes the prefetch instead of downloading again");
    await consumed;
    assert(pendingPrimes() === 0, "a consumed prefetch is not left behind");
    const independent = loadManifest(url);
    assert(fetched === before + 2, "the next manifest request is fetched afresh");
    await settle(pending.length - 1);
    await independent;
  }

  /* 3. 换集：旧实例先销毁，旧清单回包不会挂到新视频。 */
  {
    created.length = 0; pending.length = 0; fetched = 0;
    const session = new PlayerSession();
    const old = hooks(), next = hooks();
    const oldUrl = hlsUrl("episode-2"), newUrl = hlsUrl("episode-3");
    session.open({ url: oldUrl, hls: true }, old.hooks, media);
    assert(pending.length === 1, "the first episode requests its manifest");
    // 换集发生在旧清单返回之前。
    session.open({ url: newUrl, hls: true }, next.hooks, media);
    assert(pending.length === 2 && pending[1].url === newUrl, "the new episode requests its own manifest");
    // 旧回包迟到：不得创建实例或启动播放。
    await settle(0);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(FakeHls.instances().length === 0, "a late manifest for the previous episode creates nothing");
    assert(old.seen.parsed === 0 && old.seen.errors.length === 0, "stale callbacks never run");
    await settle(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const instances = FakeHls.instances();
    assert(instances.length === 1, "only the current episode builds an instance");
    assert(instances[0].source === newUrl, "the instance belongs to the current src");
    assert(!instances[0].destroyed, "the current instance is live");
    session.close();
    assert(instances[0].destroyed, "teardown destroys the live instance");
  }

  /* 4. 快速换集：连续切换时只有最后一轮生效，之前每一轮都被拆除。 */
  {
    created.length = 0; pending.length = 0;
    const session = new PlayerSession();
    const rounds = [hooks(), hooks(), hooks(), hooks()];
    const urls = ["rapid-1", "rapid-2", "rapid-3", "rapid-4"].map(hlsUrl);
    urls.forEach((url, index) => session.open({ url, hls: true }, rounds[index].hooks, media));
    assert(pending.length === 4, "each rapid switch starts its own manifest request");
    // 全部按顺序回包。
    for (let index = 0; index < 4; index += 1) {
      await settle(index);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    const instances = FakeHls.instances();
    assert(instances.length === 1, "rapid switching builds exactly one instance for the final src");
    assert(instances[0].source === urls[3], "the surviving instance uses the last src");
    assert(pendingPrimes() === 0, "superseded prefetches are discarded, not left dangling");
    const fired = rounds.filter((round) => round.seen.parsed > 0).length;
    assert(fired === 0, "no earlier round has had a chance to report success");
    session.close();
    assert(instances[0].destroyed, "the final instance is torn down on close");
  }

  /* 5. 清单失败：报错，不创建实例，下一轮仍可正常播放。 */
  {
    created.length = 0; pending.length = 0;
    const session = new PlayerSession();
    const failed = hooks();
    session.open({ url: hlsUrl("broken"), hls: true }, failed.hooks, media);
    await failPending(0, "播放清单请求失败 (HTTP 502)");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(failed.seen.errors.length === 1, "a manifest failure surfaces one error");
    assert(failed.seen.errors[0].includes("502"), "the error keeps the upstream status");
    assert(FakeHls.instances().length === 0, "no instance is built for a failed manifest");
    const recovered = hooks();
    session.open({ url: hlsUrl("recovered"), hls: true }, recovered.hooks, media);
    await settle(pending.length - 1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(FakeHls.instances().length === 1 && !FakeHls.instances()[0].destroyed, "the next episode plays normally");
    session.close();
  }

  /* 5b. 上游返回的不是 m3u8 时明确报错，同样不建实例。 */
  {
    created.length = 0; pending.length = 0;
    const session = new PlayerSession();
    const bogus = hooks();
    session.open({ url: hlsUrl("not-a-playlist"), hls: true }, bogus.hooks, media);
    await settle(pending.length - 1, "<html><body>403 Forbidden</body></html>");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(bogus.seen.errors.length === 1 && bogus.seen.errors[0].includes("播放列表"), "a non-m3u8 response is reported as a playlist failure");
    assert(FakeHls.instances().length === 0, "a non-m3u8 response builds no instance");
    session.close();
  }

  /* 6. 非 HLS 媒体直接交给元素，不经过 hls.js。 */
  {
    created.length = 0;
    pending.length = 0;
    const session = new PlayerSession();
    const direct = hooks();
    media.removeAttribute("src");
    session.open({ url: "http://hg.localhost/seg?u=x.mp4", hls: false }, direct.hooks, media);
    assert(direct.seen.natives.length === 1, "a direct media url is handed to the element");
    assert(FakeHls.instances().length === 0, "direct media never builds an hls.js instance");
    assert(pending.length === 0, "direct media does not fetch a manifest");
    session.close();
  }

  /* 7. VideoSurface：src 变化会销毁上一轮实例、取消看门狗并解绑媒体节点。 */
  {
    created.length = 0; pending.length = 0;
    const { default: VideoSurface } = await import("../src/components/VideoSurface");
    const { createRoot: create } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = create(host);
    const firstUrl = hlsUrl("surface-1"), secondUrl = hlsUrl("surface-2");
    const props = { autoPlay: false, muted: true };
    await act(async () => root.render(React.createElement(VideoSurface, { ...props, src: firstUrl })));
    assert(pending.length === 1, "mounting the surface requests the manifest");
    await settle(0);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(pendingPrimes() === 0, "the surface consumes its prefetched manifest");
    // 换 src：卸载时上一轮必须被拆除。
    await act(async () => root.render(React.createElement(VideoSurface, { ...props, src: secondUrl })));
    const pendingBefore = pending.length;
    assert(pendingBefore === 2 && pending[pendingBefore - 1].url === secondUrl, "the new src requests its own manifest");
    // 迟到的旧 URL 回包不会创建实例。
    await settle(0);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(FakeHls.instances().filter((hls) => hls.source === firstUrl && !hls.destroyed).length === 0, "the outdated manifest cannot attach to the new episode");
    await settle(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const live = FakeHls.instances().filter((hls) => !hls.destroyed && hls.source === secondUrl);
    assert(live.length === 1, "the surface keeps one live instance for the new src");
    await act(async () => root.unmount());
    assert(FakeHls.instances().every((hls) => hls.destroyed), "unmounting destroys the instance");
    host.remove();
  }

  /* 8. VideoSurface：同一 src 并发挂载时，清单请求合并为一次。 */
  {
    created.length = 0; pending.length = 0;
    const { default: VideoSurface } = await import("../src/components/VideoSurface");
    const { createRoot: create } = await import("react-dom/client");
    const hosts = [document.createElement("div"), document.createElement("div")];
    hosts.forEach((host) => document.body.appendChild(host));
    const roots = hosts.map((host) => create(host));
    const url = hlsUrl("surface-shared");
    await act(async () => {
      roots.forEach((root) => root.render(React.createElement(VideoSurface, { src: url, autoPlay: false, muted: true })));
    });
    assert(pending.filter((request) => request.url === url).length === 1, "two surfaces opening one src share a single manifest request");
    await settle(pending.length - 1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert(pendingPrimes() === 0, "the shared manifest is handed to the player and not left over");
    await act(async () => roots.forEach((root) => root.unmount()));
    hosts.forEach((host) => host.remove());
  }

  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 0, checks });
} catch (error) {
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: checks.length, failed: 1, error: String(error), checks });
} finally {
  globalThis.fetch = nativeFetch;
  setPlayerLoader(null);
  await act(async () => createRoot(document.querySelector("#fixture")!).unmount());
}
