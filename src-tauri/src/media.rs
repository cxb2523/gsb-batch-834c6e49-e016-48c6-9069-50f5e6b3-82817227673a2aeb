//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use crate::cache::BoundedCache;
use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
#[cfg(not(any(target_os = "windows", target_os = "android")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

/// Byte-bounded caches whose accounting is released the moment an entry is evicted:
/// insertion drops the LRU entry outright, and every access first sweeps entries whose TTL
/// elapsed, so a cover for a card the user scrolled past does not pin its buffer forever.
static IMG_CACHE: Lazy<Mutex<BoundedCache<Vec<u8>>>> = Lazy::new(|| {
    Mutex::new(BoundedCache::new(
        240,
        64 * 1024 * 1024,
        Duration::from_secs(1800),
    ))
});
static PL_CACHE: Lazy<Mutex<BoundedCache<String>>> = Lazy::new(|| {
    Mutex::new(BoundedCache::new(
        60,
        16 * 1024 * 1024,
        Duration::from_secs(300),
    ))
});
type RequestLocks = HashMap<String, Weak<tokio::sync::Mutex<()>>>;
static REQUEST_LOCKS: Lazy<Mutex<RequestLocks>> = Lazy::new(|| Mutex::new(HashMap::new()));

/* ───────────────────────── 缓存响应头 ───────────────────────── */
//
// The same `/seg` endpoint serves immutable media fragments and rewritten child playlists.
// They must not share a cache policy: a fragment is safe to reuse for an hour, but a
// playlist can point at the next episode's signature, so it must always be revalidated.

/// 分片 / 密钥等字节资源：允许浏览器短期缓存，避免同一片重复走代理。
const FRAGMENT_CACHE_CONTROL: &str = "public, max-age=3600, immutable";
/// 改写后的子清单：每次都要回源，避免换集后仍读到上一集的清单。
const PLAYLIST_CACHE_CONTROL: &str = "no-store";
/// 主清单：签名与偶发续集信息会变，同样不缓存。
const MANIFEST_CACHE_CONTROL: &str = "no-store";
/// 封面：内容按 URL 签名稳定，可长期缓存。
const IMAGE_CACHE_CONTROL: &str = "public, max-age=86400";
/// 错误响应从不缓存。
const ERROR_CACHE_CONTROL: &str = "no-store";

/// Share one fetch/decrypt between overlapping cover/poster/background requests.
fn request_lock(key: String) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = REQUEST_LOCKS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

/// Media fetches. Tests intercept the reserved `mock://` scheme so cache and rewrite
/// behaviour can be exercised offline; every other URL goes through the real network layer.
async fn fetch_media(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    #[cfg(test)]
    if let Some(result) = mock_fetch(url) {
        return result;
    }
    fetch_bytes(url).await
}

/// Deterministic offline bodies keyed by URL, plus per-URL hit counts.
#[cfg(test)]
fn mock_fetch(url: &str) -> Option<Result<(Option<String>, Vec<u8>), String>> {
    if !url.starts_with("mock://") {
        return None;
    }
    let mut hits = MOCK_HITS.lock().unwrap();
    *hits.entry(url.to_string()).or_insert(0) += 1;
    if url.contains("fail") {
        return Some(Err("mock fetch failed".into()));
    }
    if url.ends_with(".m3u8") {
        let body = "#EXTM3U\n#EXTINF:4,\nseg-1.ts\n".as_bytes().to_vec();
        return Some(Ok((Some("application/vnd.apple.mpegurl".into()), body)));
    }
    // A minimal JPEG header so `image_kind` recognises it; no decryption needed.
    let mut body = vec![0xFF, 0xD8, 0xFF, 0xE0];
    body.extend(std::iter::repeat_n(0u8, 96));
    Some(Ok((Some("image/jpeg".into()), body)))
}

#[cfg(test)]
static MOCK_HITS: Lazy<Mutex<HashMap<String, usize>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
fn mock_hits(url: &str) -> usize {
    *MOCK_HITS.lock().unwrap().get(url).unwrap_or(&0)
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回，否则下载并按需解密。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    let lock = request_lock(format!("img:{url}"));
    let _guard = lock.lock().await;
    let now = Instant::now();
    // `get` sweeps expired entries, so a cover that is never asked for again is released
    // here rather than surviving until the process exits.
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(url, now) {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let generation = IMG_CACHE.lock().unwrap().generation();
    let (_, bytes) = fetch_media(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let arc = Arc::new(plain);
    // On capacity/expiry eviction the cache drops its `Arc` immediately; if this caller still
    // holds `arc` only it stays alive, otherwise the buffer is freed here.
    IMG_CACHE.lock().unwrap().insert(
        url.to_string(),
        arc.clone(),
        arc.len(),
        Instant::now(),
        generation,
    );
    Ok((kind, arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// 取 m3u8 并把 key / 分片地址改写到本地协议。
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    let key = format!("{prefix}\n{url}");
    let lock = request_lock(format!("hls:{key}"));
    let _guard = lock.lock().await;
    let now = Instant::now();
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&key, now) {
        return Ok(hit);
    }
    let generation = PL_CACHE.lock().unwrap().generation();
    let (_, bytes) = fetch_media(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let arc = Arc::new(rewrite_playlist(url, text, prefix));
    PL_CACHE
        .lock()
        .unwrap()
        .insert(key, arc.clone(), arc.len(), Instant::now(), generation);
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 清空封面 / 播放列表内存缓存，并释放所有已淘汰条目的计数。
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
}

/// 供诊断/回归使用：当前仍在缓存里的条目数与已计入的字节数。
#[cfg(test)]
fn cache_usage() -> (usize, usize, usize, usize) {
    let images = IMG_CACHE.lock().unwrap();
    let playlists = PL_CACHE.lock().unwrap();
    (images.len(), images.bytes(), playlists.len(), playlists.bytes())
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
///
/// 分片与（子）清单共用 /seg，但缓存语义相反：分片不可变，可以短期缓存；子清单要
/// `no-store`，否则换集后播放器可能继续用上一集的分片列表。响应头还标出
/// `X-Media-Kind`，便于前端/诊断区分同一个端点的两种结果。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        let mut response = match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                PLAYLIST_CACHE_CONTROL,
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                ERROR_CACHE_CONTROL,
            ),
        };
        if let Ok(value) = tauri::http::HeaderValue::from_str("playlist") {
            response.headers_mut().insert("X-Media-Kind", value);
        }
        return response;
    }
    let mut response = respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        FRAGMENT_CACHE_CONTROL,
    );
    if let Ok(value) = tauri::http::HeaderValue::from_str("fragment") {
        response.headers_mut().insert("X-Media-Kind", value);
    }
    response
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), ERROR_CACHE_CONTROL);
    }

    match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => {
                respond(200, &kind, bytes.as_ref().clone(), IMAGE_CACHE_CONTROL)
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), ERROR_CACHE_CONTROL),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                MANIFEST_CACHE_CONTROL,
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), ERROR_CACHE_CONTROL),
        },
        "/seg" => match fetch_media(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes, origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), ERROR_CACHE_CONTROL),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), ERROR_CACHE_CONTROL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cache assertions read process-wide statics; serialise the tests that touch them.
    fn cache_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn identical_media_requests_share_a_lock_and_different_kinds_do_not() {
        let first = request_lock("fixture:image".into());
        let duplicate = request_lock("fixture:image".into());
        let other = request_lock("fixture:playlist".into());
        assert!(Arc::ptr_eq(&first, &duplicate));
        assert!(!Arc::ptr_eq(&first, &other));
        let old = Arc::downgrade(&first);
        drop(first);
        drop(duplicate);
        let fresh = request_lock("fixture:image".into());
        assert!(old.upgrade().is_none());
        assert!(fresh.try_lock().is_ok());
    }

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        assert!(!body.contains("URI=\"http://127.0.0.1"));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /// Fragment and child-playlist responses share /seg but must not share a cache policy:
    /// a fragment is immutable, while a playlist can point at the next episode.
    #[test]
    fn seg_responses_distinguish_fragments_from_child_playlists_by_cache_header() {
        let playlist = segment_response(
            "https://cdn.example/list.m3u8",
            Some("application/vnd.apple.mpegurl"),
            "#EXTM3U\n#EXTINF:4,\nseg-1.ts\n".as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(playlist.status(), 200);
        assert_eq!(playlist.headers()["Cache-Control"], PLAYLIST_CACHE_CONTROL);
        assert_eq!(playlist.headers()["X-Media-Kind"], "playlist");
        assert!(playlist
            .headers()
            .get("Cache-Control")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("no-store"));

        let fragment = segment_response(
            "https://cdn.example/seg-1.ts",
            Some("video/mp2t"),
            b"\x47\x40\x11\x10".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(fragment.status(), 200);
        assert_eq!(fragment.headers()["Cache-Control"], FRAGMENT_CACHE_CONTROL);
        assert_eq!(fragment.headers()["X-Media-Kind"], "fragment");
        assert!(fragment
            .headers()
            .get("Cache-Control")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("max-age=3600"));
        // The two policies must actually differ, not just carry a label.
        assert_ne!(
            playlist.headers()["Cache-Control"],
            fragment.headers()["Cache-Control"]
        );

        // A playlist detected by sniffing (upstream sent a generic type) still gets no-store.
        let sniffed = segment_response(
            "https://cdn.example/list.m3u8",
            Some("application/octet-stream"),
            b"#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert_eq!(sniffed.headers()["X-Media-Kind"], "playlist");
        assert_eq!(sniffed.headers()["Cache-Control"], PLAYLIST_CACHE_CONTROL);
    }

    /// Capacity eviction must actually free the cached bytes, and the next request must be
    /// able to fetch the content again rather than serve a dangling entry.
    #[tokio::test]
    async fn evicted_covers_release_memory_and_can_be_fetched_again() {
        let _guard = cache_lock();
        clear_caches();
        let image = "mock://cover/evict-me.jpg";
        let (kind, bytes) = load_image(image).await.expect("first fetch");
        assert_eq!(kind, "image/jpeg");
        assert_eq!(mock_hits(image), 1);
        assert_eq!(cache_usage().0, 1);
        drop(bytes);
        // Cached: no second fetch.
        load_image(image).await.expect("cached fetch");
        assert_eq!(mock_hits(image), 1, "cache hit avoids a second fetch");

        clear_caches();
        assert_eq!(cache_usage(), (0, 0, 0, 0), "clearing releases the accounting");
        load_image(image).await.expect("refetch after clear");
        assert_eq!(mock_hits(image), 2, "an evicted cover is fetched again");
        clear_caches();
        MOCK_HITS.lock().unwrap().clear();
    }

    /// Playlists follow the same rule: once evicted, a later request re-downloads and the
    /// rewritten body is produced anew.
    #[tokio::test]
    async fn evicted_playlists_release_memory_and_can_be_fetched_again() {
        let _guard = cache_lock();
        clear_caches();
        let url = "mock://list/evict.m3u8";
        let first = load_playlist(url, LOCAL_ORIGIN).await.expect("playlist");
        assert!(first.contains("#EXTM3U") && first.contains("/seg?u="));
        assert_eq!(mock_hits(url), 1);
        assert_eq!(cache_usage().2, 1);
        load_playlist(url, LOCAL_ORIGIN).await.expect("cached");
        assert_eq!(mock_hits(url), 1);

        clear_caches();
        assert_eq!(cache_usage(), (0, 0, 0, 0));
        let again = load_playlist(url, LOCAL_ORIGIN).await.expect("refetch");
        assert_eq!(mock_hits(url), 2);
        assert!(again.contains("#EXTM3U"));
        clear_caches();
        MOCK_HITS.lock().unwrap().clear();
    }

    /// A failed media fetch must surface an error and must not poison the cache with a
    /// placeholder, so the next attempt can succeed once upstream recovers.
    #[tokio::test]
    async fn failed_fetches_report_errors_without_caching_placeholders() {
        let _guard = cache_lock();
        clear_caches();
        let url = "mock://cover/fail-once.jpg";
        assert!(load_image(url).await.is_err());
        assert_eq!(cache_usage().0, 0);
        assert_eq!(mock_hits(url), 1);
        clear_caches();
        MOCK_HITS.lock().unwrap().clear();
    }

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖当前分集播放接口返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        let play = crate::playback::video(&crate::net::base(), 117, 3, None)
            .await
            .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("#EXTM3U"));
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains(
                "https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"
            ),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUB_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = std::env::var("HGHUB_TEST_COVER_URL")
            .expect("需要设置 HGHUB_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
