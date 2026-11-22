import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type Hls from "hls.js";
import { isLocalMedia, mediaUrl } from "../api";
import { PlayerSession } from "../playback-session";

export type VideoHandle = {
  el: () => HTMLVideoElement | null; play: () => void; pause: () => void; toggle: () => void;
  seek: (time: number) => void; rate: (rate: number) => void; mute: (muted: boolean) => void; volume: (volume: number) => void;
};
type Props = {
  src: string; poster?: string; autoPlay?: boolean; active?: boolean; enhancedBuffer?: boolean;
  muted?: boolean; loop?: boolean; fit?: "contain" | "cover"; volume?: number; rate?: number;
  onTime?: (time: number) => void; onDuration?: (duration: number) => void; onSize?: (width: number, height: number) => void;
  onPlaying?: () => void; onPause?: () => void; onWaiting?: () => void; onEnded?: () => void;
  onError?: (message: string) => void; onClick?: () => void; onIntent?: (playing: boolean) => void;
  onResumeRequired?: () => void; className?: string;
};

/** 看门狗在「没有任何进度」多久后判定为卡死。 */
const STALL_LIMIT_MS = 12_000;
const STALL_LIMIT_RELAXED_MS = 20_000;

/**
 * Bounded HLS buffering, explicit play intent, lazy codec loading and complete teardown.
 *
 * `src` 变化即开始新一轮：上一轮的 hls.js 被销毁、看门狗与挂起定时器被取消、媒体节点
 * 解除绑定。迟到的清单/引擎回包属于上一轮，不会挂到新视频上。
 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(props, ref) {
  const { src, poster, autoPlay = true, active = true, enhancedBuffer = true, muted = false, loop = false,
    fit = "contain", volume = 1, rate = 1, className = "" } = props;
  const videoRef = useRef<HTMLVideoElement>(null), hlsRef = useRef<PlayerSession | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const wanted = useRef(autoPlay), released = useRef(false), releaseTimer = useRef<number | undefined>(undefined);
  const pendingSeek = useRef<{ time: number; at: number } | null>(null);
  const [ready, setReady] = useState(false);
  const visible = () => callbacks.current.active !== false && document.visibilityState !== "hidden";
  const report = (message: string) => callbacks.current.onError?.(message);
  const start = () => {
    if (!visible() || !wanted.current) return;
    window.clearTimeout(releaseTimer.current);
    if (released.current) { callbacks.current.onResumeRequired?.(); return; }
    const video = videoRef.current;
    if (video?.src) video.play().catch((error: DOMException) => {
      if (error.name === "AbortError") return;
      if (error.name === "NotAllowedError") {
        wanted.current = false; callbacks.current.onIntent?.(false); callbacks.current.onPause?.();
      } else report("浏览器无法播放当前媒体，请重试");
    });
  };
  const suspend = () => {
    videoRef.current?.pause();
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      hlsRef.current?.instance?.stopLoad(); released.current = true;
    }, 60_000);
  };
  const intent = (play: boolean) => {
    wanted.current = play; callbacks.current.onIntent?.(play);
    if (play) start(); else suspend();
  };
  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => intent(true), pause: () => intent(false), toggle: () => intent(videoRef.current?.paused ?? true),
    seek: (time) => {
      const video = videoRef.current;
      if (video && Number.isFinite(time)) {
        const target = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : time, time));
        pendingSeek.current = { time: target, at: performance.now() };
        video.currentTime = target;
        callbacks.current.onTime?.(target);
      }
    },
    rate: (value) => { if (videoRef.current && Number.isFinite(value) && value > 0) videoRef.current.playbackRate = value; },
    mute: (value) => { if (videoRef.current) videoRef.current.muted = value; },
    volume: (value) => { if (videoRef.current && Number.isFinite(value)) videoRef.current.volume = Math.max(0, Math.min(1, value)); },
  }), []);

  const applySettings = () => {
    const video = videoRef.current; if (!video) return;
    video.volume = Math.max(0, Math.min(1, callbacks.current.volume ?? 1));
    video.muted = callbacks.current.muted ?? false;
    video.playbackRate = callbacks.current.rate ?? 1;
  };
  useEffect(applySettings, [volume, muted, rate]);
  useEffect(() => {
    wanted.current = autoPlay;
    if (active && document.visibilityState !== "hidden" && wanted.current) start(); else suspend();
    // Latest callbacks and settings are read through refs; never recreate the stream for play/pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, active]);
  useEffect(() => {
    const visibility = () => { if (visible() && wanted.current) start(); else suspend(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); window.clearTimeout(releaseTimer.current); };
  }, []);
  useEffect(() => {
    const hls = hlsRef.current?.instance;
    if (hls) { hls.config.maxBufferLength = enhancedBuffer ? 60 : 20; hls.config.maxBufferSize = (enhancedBuffer ? 32 : 20) * 1024 * 1024; }
  }, [enhancedBuffer]);

  useEffect(() => {
    const video = videoRef.current; if (!video || !src) return;
    const session = hlsRef.current ??= new PlayerSession();
    let disposed = false, failed = false;
    let lastTime = -1, lastProgress = performance.now();
    pendingSeek.current = null; released.current = false; setReady(false); applySettings();
    const url = isLocalMedia(src) ? src : mediaUrl(src);
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true; session.instance?.stopLoad(); report(message);
    };
    session.open(
      { url, hls: url.includes("/hls?u=") },
      {
        enhancedBuffer: () => callbacks.current.enhancedBuffer !== false,
        onHls: (hls: Hls, Events: typeof Hls.Events) => hls.on(Events.MANIFEST_PARSED, () => { if (!disposed) start(); }),
        onError: (message: string) => fail(message),
        onNative: (media: string) => { if (!disposed) { video.src = media; start(); } },
      },
      video,
    );

    const watchdog = window.setInterval(() => {
      if (disposed || failed) return;
      const element = videoRef.current;
      if (!element) return;
      const now = performance.now();
      if (!wanted.current || !visible() || element.paused || element.ended || element.seeking) {
        lastProgress = now; lastTime = element.currentTime; return;
      }
      if (Math.abs(element.currentTime - lastTime) > .15) { lastProgress = now; lastTime = element.currentTime; }
      const limit = callbacks.current.enhancedBuffer === false ? STALL_LIMIT_RELAXED_MS : STALL_LIMIT_MS;
      if (now - lastProgress > limit) fail("视频长时间未响应，正在刷新播放地址");
    }, 1000);

    return () => {
      // 先作废本轮回包，再逐一拆除定时器与媒体节点。
      disposed = true;
      window.clearInterval(watchdog);
      window.clearTimeout(releaseTimer.current);
      releaseTimer.current = undefined;
      session.close();
      // 用本轮开始时捕获的节点：卸载时 React 可能已经把 ref 置空。
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    // Latest callbacks and settings are read through refs; never recreate the stream for play/pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => () => { hlsRef.current?.close(); hlsRef.current = null; }, []);

  return <video ref={videoRef} poster={poster} playsInline loop={loop} preload="metadata"
    onClick={props.onClick} className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
    style={{ opacity: ready || poster ? 1 : 0, transition: "opacity .25s" }}
    onLoadedData={() => { setReady(true); applySettings(); }}
    onLoadedMetadata={(event) => {
      const video = event.currentTarget; applySettings();
      callbacks.current.onDuration?.(Number.isFinite(video.duration) ? video.duration : 0);
      callbacks.current.onSize?.(video.videoWidth, video.videoHeight);
      start();
    }}
    onTimeUpdate={(event) => {
      const current = event.currentTarget.currentTime, pending = pendingSeek.current;
      if (pending && Math.abs(current - pending.time) > .75 && performance.now() - pending.at < 3000) return;
      if (pending && !event.currentTarget.seeking) pendingSeek.current = null;
      callbacks.current.onTime?.(current);
    }}
    onSeeked={(event) => {
      const current = event.currentTarget.currentTime, pending = pendingSeek.current;
      if (!pending || Math.abs(current - pending.time) <= .75) { pendingSeek.current = null; callbacks.current.onTime?.(current); }
    }}
    onPause={() => callbacks.current.onPause?.()} onWaiting={() => callbacks.current.onWaiting?.()}
    onPlaying={() => callbacks.current.onPlaying?.()}
    onError={(event) => { if (event.currentTarget.error && event.currentTarget.hasAttribute("src")) report(`媒体加载失败 (${event.currentTarget.error.code})`); }}
    onEnded={() => callbacks.current.onEnded?.()} />;
});
export default VideoSurface;
