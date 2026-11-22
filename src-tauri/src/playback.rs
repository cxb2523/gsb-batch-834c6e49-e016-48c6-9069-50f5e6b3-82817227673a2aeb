//! Current upstream playback transport, matching the public site's playback service.
//! Signed URLs and ephemeral encryption keys stay in memory only.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use once_cell::sync::Lazy;
use ring::{aead, agreement, hkdf, rand::SystemRandom};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Sessions are keyed by line origin. A signed playback session is only valid for the
/// line it was negotiated on, so switching lines must never reuse or clear another line's
/// session in place.
static SESSIONS: Lazy<std::sync::Mutex<HashMap<String, Line>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

const MAX_SEQUENCE: u32 = 16384;
/// Keep a handful of recent lines warm; beyond that evict the least recently used one only.
const MAX_LINES: usize = 6;

type OpenFuture = Pin<Box<dyn Future<Output = Result<Session, String>> + Send>>;

/// One origin's playback session slot.
///
/// `session` is `None` while a handshake is in flight or after it failed: callers that
/// arrive meanwhile wait on the same mutex, so a burst of concurrent address requests for
/// one line performs exactly one handshake. Holding the guard across the encrypted call
/// also serialises `sequence` / `clock_offset`, which the response binds by value.
struct Line {
    session: Arc<Mutex<Option<Session>>>,
    /// Cached copy of the session deadline for cheap pruning; `None` while opening.
    expires: Arc<std::sync::Mutex<Option<Instant>>>,
    used: Instant,
}

impl Line {
    fn new(now: Instant) -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            expires: Arc::new(std::sync::Mutex::new(None)),
            used: now,
        }
    }

    fn expired(&self, now: Instant) -> bool {
        self.expires
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some_and(|expires| now >= expires)
    }
}

fn lines() -> std::sync::MutexGuard<'static, HashMap<String, Line>> {
    SESSIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// What one address request held when it finished, so a failure can be attributed
/// to exactly that line/session instead of clearing unrelated state.
struct Lease {
    origin: String,
    session: Arc<Mutex<Option<Session>>>,
    expires: Arc<std::sync::Mutex<Option<Instant>>>,
}

impl Lease {
    /// Release every expired line, then (if this attempt failed) drop this line's slot so
    /// the next request renegotiates. Other lines are untouched: an in-flight request for
    /// a different line must not lose its session because this one errored.
    fn finish(self, failed: bool) {
        let now = Instant::now();
        {
            let mut map = lines();
            prune_expired(&mut map, now);
        }
        if failed {
            forget_line(&self.origin, &self.session);
            // Clear under our own lock too; a waiter that already cloned the slot must see
            // that the session it was about to reuse is gone.
            if let Ok(mut slot) = self.session.try_lock() {
                *slot = None;
            }
            if let Ok(mut expires) = self.expires.lock() {
                *expires = None;
            }
        }
    }
}

/// Callers that hold a line's async mutex keep the map lock out of the picture entirely;
/// the map is only touched before locking a line, never after, so the two never deadlock.
fn line_for(origin: &str, now: Instant) -> Line {
    let mut map = lines();
    prune_expired(&mut map, now);
    let (session, expires) = match map.entry(origin.to_string()) {
        std::collections::hash_map::Entry::Occupied(mut slot) => {
            slot.get_mut().used = now;
            (slot.get().session.clone(), slot.get().expires.clone())
        }
        std::collections::hash_map::Entry::Vacant(slot) => {
            let fresh = Line::new(now);
            let pair = (fresh.session.clone(), fresh.expires.clone());
            slot.insert(fresh);
            pair
        }
    };
    evict_over_capacity(&mut map, MAX_LINES);
    Line {
        session,
        expires,
        used: now,
    }
}

/// Drop sessions whose lifetime elapsed. Only those lines are removed.
fn prune_expired(map: &mut HashMap<String, Line>, now: Instant) {
    map.retain(|_, line| !line.expired(now));
}

/// 线路切换后调用：只保留当前线路（以及它正在使用的会话），其余线路的会话一并淘汰。
///
/// 旧会话里带着旧站点的密钥与序号，换线后既不能复用也不该滞留内存。这里逐条删除，
/// 不作为「整体清空」：目标线路若已有可用会话，继续复用。
pub(crate) fn retain_line(origin: &str) {
    let mut map = lines();
    map.retain(|key, _| key == origin);
}

/// Bound memory when the user cycles through many mirror origins.
/// Evict the least recently used line only — never wipe the whole cache, which would
/// discard sessions that other lines are actively using.
fn evict_over_capacity(map: &mut HashMap<String, Line>, max: usize) {
    while map.len() > max {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, line)| line.used)
            .map(|(origin, _)| origin.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

fn forget_line(origin: &str, session: &Arc<Mutex<Option<Session>>>) {
    let mut map = lines();
    let ours = map
        .get(origin)
        .is_some_and(|line| Arc::ptr_eq(&line.session, session));
    if ours {
        map.remove(origin);
    }
}

/// Forget the session held by one line's slot, keeping the slot itself so waiters that
/// already cloned it see the invalidation instead of reusing a broken session.
fn invalidate(
    guard: &mut OwnedMutexGuard<Option<Session>>,
    expires: &std::sync::Mutex<Option<Instant>>,
) {
    **guard = None;
    *expires.lock().unwrap_or_else(|error| error.into_inner()) = None;
}

/// Wait for the line's session, opening (or reopening) it at most once.
///
/// `open` runs while the slot is locked, so concurrent callers observe one handshake and
/// then reuse its result instead of racing their own.
async fn ready_session(
    session: &Arc<Mutex<Option<Session>>>,
    expires: &std::sync::Mutex<Option<Instant>>,
    mut open: impl FnMut() -> OpenFuture,
) -> Result<OwnedMutexGuard<Option<Session>>, String> {
    let mut guard = session.clone().lock_owned().await;
    let stale = guard
        .as_ref()
        .is_none_or(|current| current.expires <= Instant::now() || current.sequence >= MAX_SEQUENCE);
    if stale {
        invalidate(&mut guard, expires);
        let opened = open().await?;
        *expires.lock().unwrap_or_else(|error| error.into_inner()) = Some(opened.expires);
        *guard = Some(opened);
    }
    Ok(guard)
}

struct Session {
    kid: String,
    sid: String,
    info: String,
    request_key: aead::LessSafeKey,
    response_key: aead::LessSafeKey,
    sequence: u32,
    clock_offset: i64,
    expires: Instant,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("播放响应缺少 {name}"))
}

fn identifier(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn derive(prk: &hkdf::Prk, info: &str) -> Result<aead::LessSafeKey, String> {
    let parts = [info.as_bytes()];
    let okm = prk
        .expand(&parts, hkdf::HKDF_SHA256)
        .map_err(|_| "播放密钥派生失败")?;
    let mut key = [0u8; 32];
    okm.fill(&mut key).map_err(|_| "播放密钥派生失败")?;
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "播放密钥无效")?;
    Ok(aead::LessSafeKey::new(key))
}

impl Session {
    async fn open(origin: &str) -> Result<Self, String> {
        let secret =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new())
                .map_err(|_| "无法创建播放会话")?;
        let public = secret
            .compute_public_key()
            .map_err(|_| "无法创建播放公钥")?;
        let hello = crate::net::playback_packet(
            origin,
            &json!({
                "v": 1, "type": "hello", "client_pub": URL_SAFE_NO_PAD.encode(public.as_ref()),
            }),
        )
        .await?;
        let kid = field(&hello, "kid")?;
        let sid = field(&hello, "sid")?;
        let site = field(&hello, "site")?;
        let server_time = hello["server_time"].as_i64().ok_or("播放握手时间无效")?;
        let ttl = hello["expires_at"]
            .as_i64()
            .and_then(|expires| expires.checked_sub(server_time))
            .filter(|ttl| (6..=600).contains(ttl))
            .ok_or("播放会话有效期无效")?;
        if hello["v"] != 1
            || hello["type"] != "hello"
            || !identifier(kid, 1, 64)
            || !identifier(sid, 16, 128)
            || site.is_empty()
            || site.len() > 256
            || !site
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".:[]-".contains(&c))
        {
            return Err("播放握手响应无效".into());
        }
        let salt = URL_SAFE_NO_PAD
            .decode(field(&hello, "salt")?)
            .map_err(|_| "播放握手编码无效")?;
        if salt.len() != 32 {
            return Err("播放握手盐值无效".into());
        }
        let remote = URL_SAFE_NO_PAD
            .decode(field(&hello, "server_pub")?)
            .map_err(|_| "播放公钥编码无效")?;
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, remote);
        let info = format!("dx150-edge-v1\nplayback\n{site}\n{kid}\n{sid}");
        let (request_key, response_key) = agreement::agree_ephemeral(secret, &peer, |shared| {
            let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(shared);
            Ok::<_, String>((
                derive(&prk, &format!("{info}\nreq"))?,
                derive(&prk, &format!("{info}\nres"))?,
            ))
        })
        .map_err(|_| "播放密钥协商失败")??;
        let clock_offset = server_time.checked_sub(now()).ok_or("播放握手时间无效")?;
        Ok(Self {
            kid: kid.into(),
            sid: sid.into(),
            info,
            request_key,
            response_key,
            sequence: 0,
            clock_offset,
            expires: Instant::now() + Duration::from_secs((ttl - 5) as u64),
        })
    }

    fn nonce(&self) -> aead::Nonce {
        let mut nonce = [0u8; 12];
        nonce[8..].copy_from_slice(&self.sequence.to_be_bytes());
        aead::Nonce::assume_unique_for_key(nonce)
    }

    fn aad(&self, direction: &str, timestamp: i64) -> Vec<u8> {
        format!("{}\n{direction}\n{}\n{timestamp}", self.info, self.sequence).into_bytes()
    }

    async fn call(
        &mut self,
        origin: &str,
        path: &str,
        token: Option<&str>,
    ) -> Result<Value, String> {
        self.sequence += 1;
        let timestamp = now()
            .checked_add(self.clock_offset)
            .ok_or("播放会话时间无效")?;
        let mut packet = json!({"request": {
            "method": "POST", "path": path, "body": STANDARD.encode(b"{}"), "content_type": "application/json",
        }});
        if let Some(token) = token.filter(|s| !s.is_empty()) {
            packet["authorization"] = json!(format!("Bearer {token}"));
        }
        let mut ciphertext = serde_json::to_vec(&packet).map_err(|_| "播放请求编码失败")?;
        self.request_key
            .seal_in_place_append_tag(
                self.nonce(),
                aead::Aad::from(self.aad("req", timestamp)),
                &mut ciphertext,
            )
            .map_err(|_| "播放请求加密失败")?;
        let result = crate::net::playback_packet(origin, &json!({
            "v": 1, "type": "call", "kid": self.kid, "sid": self.sid, "seq": self.sequence, "ts": timestamp,
            "ciphertext": URL_SAFE_NO_PAD.encode(ciphertext),
        })).await?;
        self.decode(result, timestamp)
    }

    fn decode(&self, result: Value, timestamp: i64) -> Result<Value, String> {
        if result["v"] != 1
            || result["type"] != "result"
            || result["kid"] != self.kid
            || result["sid"] != self.sid
            || result["seq"] != self.sequence
            || result["ts"] != timestamp
        {
            return Err("播放通道响应不匹配".into());
        }
        let mut bytes = URL_SAFE_NO_PAD
            .decode(field(&result, "ciphertext")?)
            .map_err(|_| "播放响应编码无效")?;
        let plain = self
            .response_key
            .open_in_place(
                self.nonce(),
                aead::Aad::from(self.aad("res", timestamp)),
                &mut bytes,
            )
            .map_err(|_| "播放响应校验失败")?;
        let inner: Value = serde_json::from_slice(plain).map_err(|_| "播放响应格式无效")?;
        let status = inner["status"].as_u64().ok_or("播放响应缺少状态码")?;
        if !(200..300).contains(&status) {
            return Err(format!("播放接口返回 HTTP {status}"));
        }
        let body = STANDARD
            .decode(field(&inner, "body")?)
            .map_err(|_| "播放数据编码无效")?;
        let value: Value = serde_json::from_slice(&body).map_err(|_| "播放数据格式无效")?;
        if value["status"] != 1 {
            return Err(value["msg"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("获取播放地址失败")
                .into());
        }
        Ok(value["data"].clone())
    }
}

pub(crate) async fn video(
    origin: &str,
    id: i64,
    ep: u32,
    token: Option<&str>,
) -> Result<Value, String> {
    if id <= 0 || ep == 0 || ep > i32::MAX as u32 {
        return Err("无效的视频或分集编号".into());
    }
    let origin = crate::net::normalize_base(origin).ok_or("播放请求必须使用安全 HTTPS 线路")?;
    if crate::network_policy::strict_security()
        && token.is_some()
        && !crate::net::trusted_auth_origin(&origin)
    {
        return Err("镜像线路仅供游客浏览；登录请切换到固定线路".into());
    }
    // One slot per line. Concurrent requests for the same line share a single handshake and
    // then take turns on the encrypted channel, so `sequence` and `clock_offset` stay ordered.
    let line = line_for(&origin, Instant::now());
    let lease = Lease {
        origin: origin.clone(),
        session: line.session.clone(),
        expires: line.expires.clone(),
    };
    let attempt = async {
        let mut guard = ready_session(&line.session, &line.expires, || {
            let origin = origin.clone();
            Box::pin(async move { Session::open(&origin).await }) as OpenFuture
        })
        .await?;
        let session = guard.as_mut().ok_or("播放会话不可用")?;
        let result = session
            .call(
                &origin,
                &format!("/api/videos/{id}/episodes/{ep}/playback"),
                token,
            )
            .await;
        if result.is_err() {
            // Clear before releasing the lock: a waiter queued on this slot must renegotiate
            // rather than continue on the session that just failed.
            invalidate(&mut guard, &line.expires);
        }
        result
    }
    .await;
    let failed = attempt.is_err();
    drop(line);
    lease.finish(failed);
    normalize(attempt?, id, ep)
}

fn normalize(data: Value, id: i64, ep: u32) -> Result<Value, String> {
    if data["manifest_method"] != "GET" {
        return Err("不支持的播放清单请求方式".into());
    }
    let main = field(&data["streams"], "main")?;
    if main.trim().is_empty() {
        return Err("上游暂未提供本集播放地址，请稍后重试".into());
    }
    crate::network_policy::parse_target(main)?;
    Ok(
        json!({"id": id, "ep_num": ep, "duration": 0, "title": "", "video_url": main,
        "video_url_hevc": data["streams"]["hevc"].as_str().unwrap_or("")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that inspect or prune the process-wide `SESSIONS` map share it; without this
    /// guard a parallel test's cleanup could evict another test's fixture line.
    fn sessions_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn clear_lines() {
        lines().clear();
    }

    fn fixture() -> Session {
        let key =
            || aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &[9; 32]).unwrap());
        Session {
            kid: "test".into(),
            sid: "test-session-123456".into(),
            info: "fixture".into(),
            request_key: key(),
            response_key: key(),
            sequence: 1,
            clock_offset: 0,
            expires: Instant::now() + Duration::from_secs(60),
        }
    }

    fn response(session: &Session) -> Value {
        let body =
            json!({"status": 1, "data": {"streams": {"main": "https://cdn.example/test.m3u8"}}});
        let mut bytes = serde_json::to_vec(&json!({"status": 200, "headers": {},
            "body": STANDARD.encode(serde_json::to_vec(&body).unwrap())}))
        .unwrap();
        session
            .response_key
            .seal_in_place_append_tag(
                session.nonce(),
                aead::Aad::from(session.aad("res", 123)),
                &mut bytes,
            )
            .unwrap();
        json!({"v":1, "type":"result", "kid":session.kid, "sid":session.sid, "seq":1, "ts":123,
            "ciphertext":URL_SAFE_NO_PAD.encode(bytes)})
    }

    #[test]
    fn authenticated_response_and_packet_binding() {
        let session = fixture();
        let packet = response(&session);
        assert_eq!(
            session.decode(packet.clone(), 123).unwrap()["streams"]["main"],
            "https://cdn.example/test.m3u8"
        );
        for (field, value) in [
            ("v", json!(2)),
            ("type", json!("hello")),
            ("kid", json!("other")),
            ("sid", json!("other-session")),
            ("seq", json!(2)),
            ("ts", json!(124)),
        ] {
            let mut changed = packet.clone();
            changed[field] = value;
            assert!(session.decode(changed, 123).is_err(), "must bind {field}");
        }
        let mut changed = packet;
        let mut bytes = URL_SAFE_NO_PAD
            .decode(changed["ciphertext"].as_str().unwrap())
            .unwrap();
        bytes[0] ^= 1;
        changed["ciphertext"] = json!(URL_SAFE_NO_PAD.encode(bytes));
        assert!(session.decode(changed, 123).is_err());
    }

    #[test]
    fn playback_shape_and_target_validation() {
        let data = json!({"manifest_method":"GET", "streams":{"main":"https://cdn.example/test.m3u8?auth_key=test", "hevc":""}});
        let result = normalize(data.clone(), 117, 3).unwrap();
        assert_eq!(result["ep_num"], 3);
        assert_eq!(result["video_url"], data["streams"]["main"]);
        for target in [
            "",
            "javascript:alert(1)",
            "http://127.0.0.1/test",
            "file:///C:/secret",
        ] {
            let mut invalid = data.clone();
            invalid["streams"]["main"] = json!(target);
            assert!(normalize(invalid, 117, 3).is_err());
        }
        assert!(normalize(json!({"manifest_method":"POST"}), 117, 3).is_err());
    }

    #[tokio::test]
    async fn invalid_requests_rejected_without_network() {
        assert!(video("https://huangguoai.com", -1, 1, None).await.is_err());
        assert!(video("https://huangguoai.com", 1, 0, None).await.is_err());
        assert!(video("https://mirror.invalid", 1, 1, Some("secret"))
            .await
            .unwrap_err()
            .contains("镜像线路"));
    }

    /// A cache slot the tests can drive without a real handshake.
    type Slot = (
        Arc<Mutex<Option<Session>>>,
        Arc<std::sync::Mutex<Option<Instant>>>,
    );

    fn slot_with(session: Session) -> Slot {
        let expires = session.expires;
        (
            Arc::new(Mutex::new(Some(session))),
            Arc::new(std::sync::Mutex::new(Some(expires))),
        )
    }

    fn counting_opener(
        calls: Arc<std::sync::atomic::AtomicUsize>,
        ttl: Duration,
    ) -> impl FnMut() -> OpenFuture {
        move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                let mut session = fixture();
                session.expires = Instant::now() + ttl;
                Ok(session)
            }) as OpenFuture
        }
    }

    /// Everything the response binds (nonce, AAD) is derived from `sequence`, so two callers
    /// racing on one session would both encode `seq = n` and the server would reject one.
    /// `ready_session` keeps one guard per slot: concurrent callers share the handshake and
    /// then consume distinct sequence numbers.
    #[tokio::test]
    async fn concurrent_callers_share_one_handshake_and_distinct_sequences() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (session, expires): Slot = (Arc::new(Mutex::new(None)), Arc::new(std::sync::Mutex::new(None)));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (session, expires, calls) = (session.clone(), expires.clone(), calls.clone());
            tasks.push(tokio::spawn(async move {
                let opener = counting_opener(calls, Duration::from_secs(60));
                let mut guard: OwnedMutexGuard<Option<Session>> =
                    ready_session(&session, &expires, opener).await.unwrap();
                let opened = guard.as_mut().unwrap();
                opened.sequence += 1;
                opened.sequence
            }));
        }
        let mut sequences = Vec::new();
        for task in tasks {
            sequences.push(task.await.unwrap());
        }
        sequences.sort_unstable();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "same line opens once");
        assert_eq!(
            sequences,
            (2..=9).collect::<Vec<_>>(),
            "each caller gets its own sequence, none reused"
        );
    }

    #[tokio::test]
    async fn valid_session_is_reused_and_expired_one_renegotiates() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (session, expires) = slot_with(fixture());
        let first = ready_session(&session, &expires, counting_opener(calls.clone(), Duration::from_secs(60)))
            .await
            .unwrap();
        drop(first);
        let second = ready_session(&session, &expires, counting_opener(calls.clone(), Duration::from_secs(60)))
            .await
            .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0, "live session reused");
        drop(second);

        // Expire it: the next caller must renegotiate exactly once.
        session.lock().await.as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
        let renewed = ready_session(&session, &expires, counting_opener(calls.clone(), Duration::from_secs(60)))
            .await
            .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(renewed.as_ref().unwrap().expires > Instant::now());
    }

    #[tokio::test]
    async fn sequence_exhaustion_also_renegotiates() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (session, expires) = slot_with(Session { sequence: MAX_SEQUENCE, ..fixture() });
        let guard = ready_session(&session, &expires, counting_opener(calls.clone(), Duration::from_secs(60)))
            .await
            .unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(guard.as_ref().unwrap().sequence < MAX_SEQUENCE);
    }

    #[tokio::test]
    async fn failed_handshake_propagates_and_leaves_the_slot_empty() {
        let (session, expires): Slot = (Arc::new(Mutex::new(None)), Arc::new(std::sync::Mutex::new(None)));
        let attempt = ready_session(&session, &expires, || {
            Box::pin(async { Err("握手失败".to_string()) }) as OpenFuture
        })
        .await;
        let Err(error) = attempt else {
            panic!("a failed handshake must not yield a guard");
        };
        assert_eq!(error, "握手失败");
        assert!(session.lock().await.is_none(), "no half-built session is kept");
        assert!(expires.lock().unwrap().is_none());
    }

    /// Eviction must be per-line: the whole map used to be cleared once four origins were
    /// cached, which dropped the session a concurrent request for the current line was using.
    #[test]
    fn capacity_eviction_keeps_the_live_lines_and_drops_only_the_oldest() {
        let mut map = HashMap::new();
        let mut now = Instant::now();
        for origin in ["https://a.example", "https://b.example", "https://c.example"] {
            now += Duration::from_secs(1);
            map.insert(origin.to_string(), Line::new(now));
        }
        // Touch the middle one so the least recently used is the first.
        now += Duration::from_secs(1);
        map.get_mut("https://b.example").unwrap().used = now;
        for origin in ["https://d.example", "https://e.example", "https://f.example", "https://g.example"] {
            now += Duration::from_secs(1);
            map.insert(origin.to_string(), Line::new(now));
            evict_over_capacity(&mut map, MAX_LINES);
        }
        assert_eq!(map.len(), MAX_LINES);
        assert!(!map.contains_key("https://a.example"), "oldest line evicted");
        for kept in ["https://b.example", "https://c.example", "https://g.example"] {
            assert!(map.contains_key(kept), "{kept} should stay warm");
        }
    }

    #[test]
    fn pruning_only_removes_expired_lines() {
        let now = Instant::now();
        let mut map = HashMap::new();
        let expired = Line::new(now);
        *expired.expires.lock().unwrap() = Some(now - Duration::from_secs(1));
        let open = Line::new(now);
        *open.expires.lock().unwrap() = Some(now + Duration::from_secs(60));
        let opening = Line::new(now); // deadline unknown: a handshake is in flight
        map.insert("https://expired.example".into(), expired);
        map.insert("https://open.example".into(), open);
        map.insert("https://opening.example".into(), opening);
        prune_expired(&mut map, now);
        assert_eq!(map.len(), 2);
        assert!(!map.contains_key("https://expired.example"));
        assert!(map.contains_key("https://open.example"));
        assert!(map.contains_key("https://opening.example"), "in-flight handshakes are not pruned");
    }

    /// `finish` must remove only the failed line; another line's live session survives.
    #[tokio::test]
    async fn failed_call_forgets_only_its_own_line() {
        let _guard = sessions_lock();
        clear_lines();
        let now = Instant::now();
        let other = line_for("https://other.example", now);
        other.session.lock().await.replace(fixture());
        let doomed = line_for("https://doomed.example", now);
        doomed.session.lock().await.replace(fixture());
        Lease {
            origin: "https://doomed.example".into(),
            session: doomed.session.clone(),
            expires: doomed.expires.clone(),
        }
        .finish(true);
        assert!(doomed.session.lock().await.is_none(), "the failing line is dropped");
        assert!(
            other.session.lock().await.is_some(),
            "a different line's session must not be cleared"
        );
        // A successful call must leave its line in place for reuse.
        Lease {
            origin: "https://other.example".into(),
            session: other.session.clone(),
            expires: other.expires.clone(),
        }
        .finish(false);
        assert!(other.session.lock().await.is_some());
    }

    #[tokio::test]
    async fn switching_lines_opens_a_fresh_session_per_line() {
        let _guard = sessions_lock();
        clear_lines();
        let now = Instant::now();
        let a = line_for("https://line-a.example", now);
        let b = line_for("https://line-b.example", now);
        assert!(
            !Arc::ptr_eq(&a.session, &b.session),
            "each line owns its own session slot"
        );
        a.session.lock().await.replace(fixture());
        assert!(b.session.lock().await.is_none(), "opening A cannot populate B");
        let again = line_for("https://line-a.example", now);
        assert!(Arc::ptr_eq(&a.session, &again.session), "returning to A reuses its slot");
    }

    /// 换线后旧线路的会话被淘汰，但没有「整体清空」：新线路自己的槽保留。
    #[tokio::test]
    async fn retaining_one_line_evicts_the_others_only() {
        let _guard = sessions_lock();
        clear_lines();
        let now = Instant::now();
        let old = line_for("https://old-line.example", now);
        old.session.lock().await.replace(fixture());
        let target = line_for("https://target-line.example", now);
        target.session.lock().await.replace(fixture());
        retain_line("https://target-line.example");
        assert!(
            !lines().contains_key("https://old-line.example"),
            "the previous line is evicted after switching"
        );
        assert!(lines().contains_key("https://target-line.example"));
        assert!(
            target.session.lock().await.is_some(),
            "the new line's own session survives, so it is not a blanket clear"
        );
        // Old slot's session was dropped, not just unmapped: its Arc is no longer alive.
        assert_eq!(Arc::strong_count(&old.session), 1);
        clear_lines();
    }

    #[tokio::test]
    #[ignore = "Live playback smoke: API, manifest rewrite, AES key and one segment"]
    async fn live_playback() {
        let id = std::env::var("HGHUB_TEST_VIDEO_ID")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(117);
        let ep = std::env::var("HGHUB_TEST_EP")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3);
        let info = video(crate::net::DEFAULT_BASE, id, ep, None)
            .await
            .expect("playback API");
        let playlist = crate::media::load_playlist(
            info["video_url"].as_str().unwrap(),
            crate::media::LOCAL_ORIGIN,
        )
        .await
        .expect("playlist");
        assert!(playlist.starts_with("#EXTM3U"));
        let key_line = playlist
            .lines()
            .find(|line| line.starts_with("#EXT-X-KEY"))
            .expect("key line");
        let key_url = key_line
            .split("URI=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let key = crate::media::handle(
            "/seg",
            key_url.split_once('?').unwrap().1,
            crate::media::LOCAL_ORIGIN,
        )
        .await;
        assert_eq!(key.status(), 200);
        assert_eq!(key.body().len(), 16);
        let segment = playlist
            .lines()
            .find(|line| !line.starts_with('#') && line.contains("/seg?u="))
            .expect("segment");
        let segment = crate::media::handle(
            "/seg",
            segment.split_once('?').unwrap().1,
            crate::media::LOCAL_ORIGIN,
        )
        .await;
        assert_eq!(segment.status(), 200);
        assert!(segment.body().len() > 1000);
        println!("API + HLS rewrite + 16-byte AES key + media segment OK (video {id}, ep {ep})");
    }
}
