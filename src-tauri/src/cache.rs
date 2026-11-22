//! Small memory-only LRU with byte, entry and age limits. No signed media is written to disk.
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

struct Entry<T> {
    value: Arc<T>,
    bytes: usize,
    expires: Instant,
    used: u64,
}
pub(crate) struct BoundedCache<T> {
    entries: HashMap<String, Entry<T>>,
    bytes: usize,
    max_bytes: usize,
    max_entries: usize,
    ttl: Duration,
    clock: u64,
    generation: u64,
}
impl<T> BoundedCache<T> {
    pub fn new(max_entries: usize, max_bytes: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            max_bytes,
            max_entries,
            ttl,
            clock: 0,
            generation: 0,
        }
    }
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
        }
    }
    /// Drop every expired entry and return how many were released.
    ///
    /// Without this, an entry that is never requested again (a cover for a scrolled-away
    /// card, a playlist for a finished episode) keeps its bytes alive well past the TTL:
    /// expiry was only checked for the key being looked up.
    pub fn sweep(&mut self, now: Instant) -> usize {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| now >= entry.expires)
            .map(|(key, _)| key.clone())
            .collect();
        let released = expired.len();
        for key in expired {
            self.remove(&key);
        }
        released
    }
    pub fn get(&mut self, key: &str, now: Instant) -> Option<Arc<T>> {
        self.sweep(now);
        self.clock = self.clock.saturating_add(1);
        self.entries.get_mut(key).map(|entry| {
            entry.used = self.clock;
            entry.value.clone()
        })
    }
    pub fn insert(
        &mut self,
        key: String,
        value: Arc<T>,
        bytes: usize,
        now: Instant,
        generation: u64,
    ) {
        if generation != self.generation || bytes > self.max_bytes || self.max_entries == 0 {
            return;
        }
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| now >= entry.expires)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove(&key);
        }
        self.remove(&key);
        while self.entries.len() >= self.max_entries || self.bytes + bytes > self.max_bytes {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                self.remove(&key);
            } else {
                break;
            }
        }
        self.clock = self.clock.saturating_add(1);
        self.bytes += bytes;
        self.entries.insert(
            key,
            Entry {
                value,
                bytes,
                expires: now + self.ttl,
                used: self.clock,
            },
        );
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    /// Bytes currently accounted to live entries (excludes clones still held by callers).
    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.generation = self.generation.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lru_respects_bytes_entries_and_replacements() {
        let now = Instant::now();
        let mut cache = BoundedCache::new(2, 10, Duration::from_secs(60));
        cache.insert("a".into(), Arc::new(1), 4, now, 0);
        cache.insert("b".into(), Arc::new(2), 4, now, 0);
        assert_eq!(*cache.get("a", now).unwrap(), 1);
        cache.insert("c".into(), Arc::new(3), 4, now, 0);
        assert!(cache.get("b", now).is_none());
        cache.insert("a".into(), Arc::new(4), 8, now, 0);
        assert_eq!(cache.bytes, 8);
        assert!(cache.get("c", now).is_none());
        cache.insert("huge".into(), Arc::new(5), 11, now, 0);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.bytes, 8);
    }
    #[test]
    fn access_does_not_extend_ttl_and_clear_invalidates_inflight_writes() {
        let now = Instant::now();
        let mut cache = BoundedCache::new(3, 20, Duration::from_secs(30));
        cache.insert("a".into(), Arc::new(1), 5, now, 0);
        assert!(cache.get("a", now + Duration::from_secs(29)).is_some());
        assert!(cache.get("a", now + Duration::from_secs(30)).is_none());
        assert_eq!(cache.bytes, 0);
        let previous = cache.generation();
        cache.clear();
        cache.insert("late".into(), Arc::new(2), 5, now, previous);
        assert!(cache.get("late", now).is_none());
        cache.insert("fresh".into(), Arc::new(3), 5, now, cache.generation());
        assert!(cache.get("fresh", now).is_some());
    }

    /// An entry nobody asks for again must still be released once its TTL passes.
    /// Before `sweep` existed, expiry was only checked for the key being looked up, so a
    /// cover for a card scrolled out of view pinned its bytes for the whole process.
    #[test]
    fn sweeping_releases_bytes_for_expired_entries() {
        let now = Instant::now();
        let mut cache = BoundedCache::new(8, 1024, Duration::from_secs(30));
        for i in 0..4 {
            cache.insert(format!("k{i}"), Arc::new(i), 100, now, 0);
        }
        assert_eq!((cache.len(), cache.bytes()), (4, 400));
        assert_eq!(cache.sweep(now + Duration::from_secs(29)), 0);
        assert_eq!(cache.bytes(), 400);
        assert_eq!(cache.sweep(now + Duration::from_secs(31)), 4);
        assert_eq!((cache.len(), cache.bytes()), (0, 0));
    }

    /// A plain `get` of a live key is enough to notice that other entries have expired.
    #[test]
    fn get_reclaims_other_expired_entries_without_refetching() {
        let now = Instant::now();
        let mut cache = BoundedCache::new(8, 1024, Duration::from_secs(30));
        cache.insert("drop".into(), Arc::new(2), 10, now, 0);
        let later = now + Duration::from_secs(20);
        cache.insert("keep".into(), Arc::new(1), 10, later, 0);
        let scan = now + Duration::from_secs(35);
        assert_eq!(cache.get("keep", scan).as_deref(), Some(&1), "a live entry survives the sweep");
        assert!(cache.get("drop", scan).is_none());
        assert_eq!(cache.bytes(), 10);
        // Evicted content can be fetched again once the caller reinserts it.
        cache.insert("drop".into(), Arc::new(22), 10, scan, 0);
        assert_eq!(cache.get("drop", scan).as_deref(), Some(&22));
    }

    /// The value's allocation is released, not just forgotten: the cache must not keep an
    /// `Arc` alive after capacity eviction.
    #[test]
    fn capacity_eviction_drops_the_strong_reference() {
        let now = Instant::now();
        let mut cache = BoundedCache::new(1, 1024, Duration::from_secs(600));
        let first = Arc::new(vec![7u8; 128]);
        cache.insert("first".into(), first.clone(), 128, now, 0);
        cache.insert("second".into(), Arc::new(vec![8u8; 128]), 128, now, 0);
        assert!(cache.get("first", now).is_none());
        assert_eq!(
            Arc::strong_count(&first),
            1,
            "cache dropped its only reference, so the buffer can be freed"
        );
    }
}
