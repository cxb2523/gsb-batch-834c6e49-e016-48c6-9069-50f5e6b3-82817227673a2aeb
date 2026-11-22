/* =====================================================================
 * make_demo_wrpl.mjs —— 自造小型 .wrpl 回放（验收流式解析用，不依赖真实游戏文件）
 * ---------------------------------------------------------------------
 * 产物（默认写到 ../samples/）：
 *   demo.wrpl                 正常回放：10 架飞机的 FM 航迹 + 本机属性表 + 结束标记，
 *                             地图名用 terrain/ 里已有的 air_skyscraper_city（地形能真加载）
 *   demo-broken-magic.wrpl    头部 magic 错误 → 容器阶段失败（首批之前）
 *   demo-broken-results.wrpl  结算块是垃圾 → BLK 阶段失败（首批之前、FM 之后）
 *
 * 用法：node tools/make_demo_wrpl.mjs [输出目录]
 * 也被 check-streaming-parse.mjs 当作库 import（buildDemoWrpl）。
 *
 * 格式按 web/wrpl-parse.js 的解析口径手写：
 *   1224 B 定长头 + 2 B pad + zstd 帧（**raw block**，不压缩，免依赖压缩器）
 *   包流：[VLQ 长度][ptype, 0, ms(u32 LE)][包体]，FM 包体是 MSB-first 位流
 * ===================================================================== */

const HEADER_BYTES = 1224;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/* ------------------------------------------------------------ 位写器（MSB-first，与 BitReader 对应） */
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
  bits(v, n) {
    for (let k = n - 1; k >= 0; k--) {
      this.cur = (this.cur << 1) | ((v >>> k) & 1);
      this.nbits++;
      if (this.nbits === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.nbits = 0; }
    }
  }
  byte(v) { this.bits(v & 0xff, 8); }
  bytesN(arr) { for (const b of arr) this.byte(b); }
  u16(v) { this.bits(v & 0xff, 8); this.bits((v >>> 8) & 0xff, 8); }
  u32(v) { for (let i = 0; i < 4; i++) this.bits((v >>> (8 * i)) & 0xff, 8); }
  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytesN(b);
  }
  compressed(v) {           // LEB128（BitReader.compressed）
    let x = v >>> 0;
    while (true) {
      let b = x & 0x7f; x = Math.floor(x / 128);
      if (x) b |= 0x80;
      this.byte(b);
      if (!x) break;
    }
  }
  align() { if (this.nbits) this.bits(0, 8 - this.nbits); }
  toUint8Array() { this.align(); return Uint8Array.from(this.bytes); }
}

/* ------------------------------------------------------------ VLQ 包长前缀（readVlqSize 的逆） */
function vlqSize(size) {
  if (size < 0x80) return [0x80 | size];
  if (size < 0x4000) return [0x40 | (size >> 8), size & 0xff];
  if (size < 0x10000000) {
    const v = size | 0x10000000;
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  throw new Error('包太大：' + size);
}

function packet(ptype, ms, body) {
  const size = 6 + body.length;
  const head = [...vlqSize(size), ptype & 0xff, 0,
                ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff];
  return [...head, ...body];
}

/* ------------------------------------------------------------ zstd 帧（全部用 raw block，合法但不压缩） */
function zstdRawFrame(payload) {
  const out = [];
  out.push(...ZSTD_MAGIC);
  out.push(0xa0);                       // FCS 4 字节 + single_segment
  out.push(payload.length & 0xff, (payload.length >>> 8) & 0xff,
           (payload.length >>> 16) & 0xff, (payload.length >>> 24) & 0xff);
  const MAX = 65536;
  for (let off = 0; off < payload.length; off += MAX) {
    const n = Math.min(MAX, payload.length - off);
    const last = off + n >= payload.length ? 1 : 0;
    const h = (n << 3) | last;          // block type 0 = raw
    out.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff);
    for (let i = 0; i < n; i++) out.push(payload[off + i]);
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------ 1224 B 回放头 */
function writeCString(buf, off, size, s) {
  for (let i = 0; i < size; i++) buf[off + i] = i < s.length ? s.charCodeAt(i) : 0;
}

function buildHeader(opts) {
  const h = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, opts.magic !== undefined ? opts.magic : 0x1000ace5, true);
  dv.setUint32(4, 2, true);                                   // version
  writeCString(h, 8, 128, 'levels/air_skyscraper_city.bin');  // level（terrain/ 里有这张图的素材）
  writeCString(h, 136, 260, '');
  writeCString(h, 396, 128, 'air_arcade');
  writeCString(h, 524, 128, 'day');
  writeCString(h, 652, 32, 'good');
  dv.setUint32(684, opts.rezOffset || 0, true);               // rezOffset
  h[688] = 0;                                                 // difficulty
  dv.setUint32(724, 0, true);                                 // sessionType
  for (let i = 0; i < 8; i++) h[732 + i] = i + 1;             // sessionId
  dv.setUint32(744, 0, true);                                 // mSetSize
  dv.setUint32(748, 0, true);                                 // settingsSize
  writeCString(h, 780, 128, '');
  dv.setUint32(908, 1760000000, true);                        // startTime
  dv.setUint32(912, 60, true);                                // timeLimit
  dv.setUint32(916, 0, true);                                 // scoreLimit
  writeCString(h, 968, 128, 'air');
  writeCString(h, 1096, 128, '');
  return h;
}

/* ------------------------------------------------------------ 航迹脚本
 * FM 坐标：PosX=世界 x，PosY=高度，PosZ=世界 y（解析器做 x=PosX, y=PosZ, z=PosY） */
const DUR_S = 120, STEP_S = 0.1, N_UID = 10;

function trackOf(uid, t) {
  // uid 1：本机 —— 起飞爬升 + 直线巡航（props 表按它写，方便本机认领）
  if (uid === 1) {
    const x = 5000 + 180 * t;
    const y = -2000 + 40 * t;
    const alt = Math.min(800 + 25 * t, 3500) + 50 * Math.sin(t / 3);
    return [x, alt, y];
  }
  // 其余：绕各自中心转圈（半径 2500–4000 m，角速度按 220 m/s 线速度）
  const cx = -8000 + (uid % 5) * 6000;
  const cy = (uid < 6 ? 1 : -1) * (6000 + (uid % 3) * 3000);
  const r = 2500 + (uid % 4) * 500;
  const w = 220 / r * (uid % 2 ? 1 : -1);
  const a = uid + w * t;
  const alt = 1200 + (uid % 5) * 400 + 80 * Math.sin(t / 5 + uid);
  return [cx + r * Math.cos(a), alt, cy + r * Math.sin(a)];
}

/* FM 包体：一帧内全部 uid 的条目 + 0x7FF 结束 */
function fmPacketBody(ms) {
  const t = ms / 1000;
  const w = new BitWriter();
  for (let uid = 1; uid <= N_UID; uid++) {
    const [px, alt, pz] = trackOf(uid, t);
    w.bits(1, 1);                 // 有 uid 字段
    w.compressed(uid);
    w.bits(0, 1);                 // 有数据
    w.bits(0, 1); w.bits(0, 1);   // u0/u1（不 skip）
    w.bits(0, 1); w.u32(0);
    w.bits(0, 1); w.bits(0, 1);   // flag + readUnk5(0)
    w.compressed(0);              // n11 = 0
    w.f32(px); w.f32(alt); w.f32(pz);
    w.u32(0);                     // packedEuler（bank=0）
    w.u32(0);
    w.align();
    w.bytesN([0, 0, 0, 0, 0, 0, 0]);
    w.byte(0);                    // engines
    w.byte(0);                    // sensors
    w.byte(0);                    // cm
    w.bits(0, 4);                 // targets
    w.bits(0, 1); w.bits(0, 1);
  }
  w.bits(1, 1); w.compressed(0x7ff);   // 结束标记
  return w.toUint8Array();
}

/* 本机属性表（ptype=4，签名 03 58 4a f0；8 字节头后逐对 u16le id + f32） */
function propsPacketBody(ms) {
  const t = ms / 1000;
  const [x, alt, y] = trackOf(1, t);
  const [x2, , y2] = trackOf(1, t + 0.5);
  const hdg = ((Math.atan2(x2 - x, y2 - y) * 180 / Math.PI) % 360 + 360) % 360;
  const ias = 180 + 2 * Math.sin(t / 4);
  const pairs = [
    [42, alt / 0.3048],       // alt_m（源数据是英尺）
    [0, ias],                 // ias_mps
    [64, hdg],                // hdg_deg（与位移方向一致 → y 不翻转）
    [453, ias / 340],         // mach
    [482, 1.0],               // ny
    [53, 2.5],                // pitch_deg
    [52, 15 * Math.sin(t / 6)], // roll_deg
    [39, 25 * Math.cos(t / 3)], // vario_mps
    [195, 2500 - 2 * t],      // fuel_kg
    [240, 0.85]               // throttle_0_1
  ];
  const body = [0x03, 0x58, 0x4a, 0xf0, 0, 0, 0, 0];
  const dv = new DataView(new ArrayBuffer(6));
  for (const [id, v] of pairs) {
    dv.setUint16(0, id, true);
    dv.setFloat32(2, v, true);
    for (let i = 0; i < 6; i++) body.push(dv.getUint8(i));
  }
  return body;
}

function buildPayload() {
  const bytes = [];
  for (let ms = 0; ms <= DUR_S * 1000; ms += STEP_S * 1000) {
    bytes.push(...packet(2, ms, fmPacketBody(ms)));
    if (ms % 250 === 0) bytes.push(...packet(4, ms, propsPacketBody(ms)));
  }
  bytes.push(...packet(0, DUR_S * 1000, [0]));   // EndMarker
  return Uint8Array.from(bytes);
}

/* ------------------------------------------------------------ 组装整份回放 */
export function buildDemoWrpl(kind) {
  const payload = buildPayload();
  const frame = zstdRawFrame(payload);
  const garbage = kind === 'bad-results' ? 200 : 0;
  const header = buildHeader({
    magic: kind === 'bad-magic' ? 0xdeadbeef : undefined,
    rezOffset: garbage ? HEADER_BYTES + 2 + frame.length : 0
  });
  const out = new Uint8Array(HEADER_BYTES + 2 + frame.length + garbage);
  out.set(header, 0);
  out.set(frame, HEADER_BYTES + 2);
  if (garbage) out.fill(0xaa, HEADER_BYTES + 2 + frame.length);
  return out;
}

/* ------------------------------------------------------------ CLI */
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const outDir = process.argv[2] || fileURLToPath(new URL('../samples/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  for (const [kind, name] of [['good', 'demo.wrpl'],
                              ['bad-magic', 'demo-broken-magic.wrpl'],
                              ['bad-results', 'demo-broken-results.wrpl']]) {
    const buf = buildDemoWrpl(kind);
    writeFileSync(join(outDir, name), buf);
    console.log(`${name}: ${(buf.length / 1024).toFixed(0)} KB`);
  }
}
