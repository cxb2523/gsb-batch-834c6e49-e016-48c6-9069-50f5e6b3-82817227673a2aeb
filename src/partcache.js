// The cache of rendered project parts (one MP4 per scene or transition) under <cache dir>/parts/<project hash>.
// A part is addressed by two keys:
//   baseKey  — everything known before the render: the scene page's hash, its head/tail frames, fps, scale, qp,
//              codec, motlab version and (for transitions) the two pages, the shader or layer and its parameters
//   fullKey  — the base key plus the content hashes of every project file the page actually fetched while it
//              rendered (shared scripts, fonts, pictures, footage). Any one of them changing changes the full key,
//              so the part is rendered again, and the transitions touching that scene are rendered again too.
// Both the MP4 and its JSON manifest are written through a temporary file and renamed atomically, so an aborted or
// failed render leaves only .tmp-* files (swept at startup), never a half file that could be mistaken for a part.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const partKey = o => createHash('sha256').update(JSON.stringify(o)).digest('hex');
export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// A map of project-relative path -> content hash for the files a render fetched. A missing file hashes to null, so a
// fetched file that disappears (or appears) between renders also invalidates the part. Sorted keys keep it stable.
// At lookup time the files come from the old manifest (recordedDeps), so no render is needed to re-check them.
export function dependencyHashes(root, fetchedOrDeps, hash = hashFile) {
  const out = {};
  const rels = Array.isArray(fetchedOrDeps) ? fetchedOrDeps : Object.keys(fetchedOrDeps || {});
  for (const rel of [...new Set(rels)].sort()) {
    let h = null;
    try { h = hash(join(root, rel)); } catch { h = null; }
    out[rel] = h;
  }
  return out;
}

// Rename over an existing file works on every platform Node supports: remove the destination first.
export function atomicRename(from, to) {
  rmSync(to, { force: true });
  renameSync(from, to);
}

// Write through a temp file in the same folder and rename, so readers never see a half-written document.
export function atomicWriteJson(file, value, tmpFile) {
  writeFileSync(tmpFile, JSON.stringify(value));
  atomicRename(tmpFile, file);
}

let tmpSeq = 0;
const tmpName = ext => `.tmp-${process.pid}-${++tmpSeq}-${Date.now().toString(36)}.${ext}`;

// The manifest of a still-fresh part must match the first part's codec/encoder/range (a stream copy join is only safe
// when they match), and every file it was built from must still hash now to the content recorded in the manifest.
function manifestIsFresh(m, currentDeps, first) {
  for (const [rel, recorded] of Object.entries(m.deps || {})) {
    if ((currentDeps[rel] ?? null) !== (recorded ?? null)) return false;
  }
  if (first && (m.hw !== first.hw || m.codec !== first.codec || m.fullRange !== first.fullRange)) return false;
  return true;
}

export class PartCache {
  // cacheRoot: the project's parts folder. projectRoot: the served project folder the fetched paths are relative to.
  // probe: ffprobe wrapper returning { frames, duration, width, height } for an MP4, or null for an unreadable one.
  constructor(cacheRoot, projectRoot, { probe, hash = hashFile } = {}) {
    this.cacheRoot = cacheRoot; this.projectRoot = projectRoot; this.probe = probe; this.hash = hash;
    this.used = new Set();          // keys this render touched, for pruning the parts it did not use
    this.pending = new Set();       // temp paths of parts still being written, removed if the render is aborted
    mkdirSync(cacheRoot, { recursive: true });
    this.sweep();
  }

  // Half files from an earlier run that did not reach the atomic rename. Final parts are <key>.mp4/.json, never these.
  sweep() {
    for (const f of readdirSync(this.cacheRoot)) if (f.startsWith('.tmp-')) rmSync(join(this.cacheRoot, f), { force: true });
  }

  tempPath() {
    const p = join(this.cacheRoot, tmpName('mp4'));
    this.pending.add(p);
    return p;
  }

  // Look the base key up. Returns the part descriptor when the MP4 still probes as the manifest says and every file
  // the part was built from still hashes to the recorded content, otherwise null. forced means the caller asked to
  // render this part again (--only). The dependency list lives in the manifest, so no render is needed to check it.
  async get(baseKey, { forced = false, first = null } = {}) {
    this.used.add(baseKey);
    if (forced) return null;
    let m = null;
    try { m = JSON.parse(readFileSync(join(this.cacheRoot, baseKey + '.json'), 'utf8')); } catch { return null; }
    if (m?.baseKey !== baseKey || !m.fullKey || !existsSync(join(this.cacheRoot, m.fullKey + '.mp4'))) return null;
    const now = dependencyHashes(this.projectRoot, m.deps || {}, this.hash);
    if (!manifestIsFresh(m, now, first)) return null;
    const v = await this.probe(join(this.cacheRoot, m.fullKey + '.mp4')).catch(() => null);
    if (!v || v.frames !== m.frames || Math.abs(v.duration - m.duration) > 0.5 / m.fps
        || v.width !== m.width || v.height !== m.height) return null;
    this.used.add(m.fullKey);
    return { out: join(this.cacheRoot, m.fullKey + '.mp4'), width: m.width, height: m.height, duration: m.duration,
      frames: m.frames, pageFrames: m.pageFrames, fullRange: m.fullRange, codec: m.codec, hw: m.hw };
  }

  // Finish a rendered part: hash what the render fetched, derive the full key, and publish MP4 and manifest atomically.
  // The manifest keeps the base key's name (one manifest per part input set) and points at the current full-key MP4,
  // so a fetched file changing just points the same manifest at a new MP4; the old one is pruned after the render.
  // summary is renderVideo()'s summary; its .out is the temp path it wrote. Returns the descriptor joining uses.
  async commit(baseKey, summary, { fetched = [] } = {}) {
    const deps = dependencyHashes(this.projectRoot, fetched, this.hash);
    const fullKey = partKey({ baseKey, deps });
    const mp4 = join(this.cacheRoot, fullKey + '.mp4'), json = join(this.cacheRoot, baseKey + '.json');
    const tmpJson = join(this.cacheRoot, tmpName('json'));
    try {
      atomicRename(summary.out, mp4);
      this.pending.delete(summary.out);
      atomicWriteJson(json, { baseKey, fullKey, deps, fps: summary.fps, codec: summary.codec, hw: summary.hw, fullRange: summary.fullRange,
        width: summary.width, height: summary.height, frames: summary.frames, pageFrames: summary.pageFrames, duration: summary.duration }, tmpJson);
    } catch (e) {
      this.discard(summary.out);
      rmSync(tmpJson, { force: true });
      throw e;
    }
    this.used.add(baseKey); this.used.add(fullKey);
    return { out: mp4, width: summary.width, height: summary.height, duration: summary.duration, frames: summary.frames,
      pageFrames: summary.pageFrames, fullRange: summary.fullRange, codec: summary.codec, hw: summary.hw };
  }

  // A render that never reached commit: drop its temp MP4 so nothing half-written remains.
  discard(tempPath) {
    if (!tempPath) return;
    this.pending.delete(tempPath);
    rmSync(tempPath, { force: true });
  }

  // Abort mid-render: every temp MP4 still in flight. The renamed parts stay, they are complete and reusable.
  onAbort(signal) {
    if (!signal) return () => {};
    const stop = () => { for (const p of this.pending) rmSync(p, { force: true }); this.pending.clear(); };
    signal.addEventListener('abort', stop);
    return () => signal.removeEventListener('abort', stop);
  }

  // Remove parts no render of this project used any more: both base-key and full-key files are registered in used.
  prune() {
    let n = 0;
    try {
      const keys = [...new Set(readdirSync(this.cacheRoot).map(f => /^([0-9a-f]{64})\.(mp4|json)$/.exec(f)?.[1]).filter(Boolean))];
      for (const k of keys) {
        if (this.used.has(k)) continue;
        rmSync(join(this.cacheRoot, k + '.mp4'), { force: true });
        rmSync(join(this.cacheRoot, k + '.json'), { force: true });
        n++;
      }
    } catch {}
    return n;
  }
}
