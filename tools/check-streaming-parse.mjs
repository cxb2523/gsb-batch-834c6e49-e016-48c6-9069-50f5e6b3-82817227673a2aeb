/* =====================================================================
 * check-streaming-parse.mjs —— 流式解析（首批挂载 / 分片合并 / 取消 / 失败回滚）的本地验收
 * ---------------------------------------------------------------------
 * 运行：node tools/check-streaming-parse.mjs
 * 覆盖：
 *   1. parseMain 重排后产物与非流式完全一致（不破坏现有行为）
 *   2. opts.firstBatch 在 done 前触发，首批含时间轴 + 本机 + 空中单位，可挂载形态
 *   3. 进度百分比单调不减（阶段重排后不回退）
 *   4. 分片合并（mergePartInto）：store 路径组装结果 == parseMain 直出
 *   5. 流式合并进首批对象：units 替换不重复、own 分片合并、terrain/names 不被占位覆盖，
 *      合并完成 == parseMain 直出；重复合并 meta 幂等
 *   6. debugFailAfterFirstBatch 验收钩子：首批后失败 → Promise 拒绝且首批已发
 *   7. 坏文件：magic 错 → unsupported-format；结算块垃圾 → 解析错误
 *   8. WRPLParse.cancel() 空调用不抛错
 * 浏览器端（Worker 协议 / 挂载幂等 / 回滚）的验收步骤见 docs/STREAMING-PARSE.md。
 * ===================================================================== */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildDemoWrpl } from './make_demo_wrpl.mjs';

const require = createRequire(import.meta.url);
globalThis.fzstd = require('../web/vendor/fzstd.min.js');
require('../web/ecs-comps.js');
require('../web/ecs-names.js');
require('../web/wrpl-parse.js');
const WRPLParse = globalThis.WRPLParse;
const I = WRPLParse._internal;

const J = (o) => JSON.parse(JSON.stringify(o));   // 去掉 -0/undefined 差异的深比较副本

/* 进度监听（parseMain 直接 emit） */
let progressLog = [];
WRPLParse.progress((p) => { progressLog.push(p); });

const good = buildDemoWrpl('good');
console.log(`demo.wrpl = ${(good.length / 1024).toFixed(0)} KB`);

/* ---- 1/2. 非流式基线 vs 流式（首批 + 最终一致） ---- */
progressLog = [];
const m0 = await I.parseMain(good, {});
assert.equal(m0.meta.source, 'wrpl');
assert.ok(m0.meta.window.t1 > 100, '窗口约 120 s');
assert.ok(m0.units.length >= 9, '至少 9 条他机航迹（本机被摘出）');
assert.ok(m0.own && m0.own.n > 1000, '本机 10 Hz 采样');
assert.ok(m0.meta.counts.ownSamples > 1000);

progressLog = [];
let first = null, firstAtPct = null;
const m1 = await I.parseMain(good, {
  firstBatch(m) { first = m; firstAtPct = progressLog.length ? progressLog[progressLog.length - 1].pct : null; }
});
assert.ok(first, 'firstBatch 应触发一次');
assert.ok(firstAtPct !== null && firstAtPct <= 55, `首批应在解析前半段发出（实际 pct=${firstAtPct}）`);
assert.ok(first.meta && first.meta.window && first.meta.window.t1 > 100, '首批带时间轴');
assert.ok(first.own && first.own.n > 1000, '首批带本机通道');
assert.ok(first.units.length >= 9, '首批带空中单位');
assert.ok(Array.isArray(first.events) && first.events.length === 0, '首批事件为空（后续分片合并）');
assert.equal(first.meta.source, 'wrpl', '首批 meta.source 正确（mission.js 不报警）');
assert.equal(first.own.n, m1.own.n, '本机认领在首批与最终一致（本回放 uidMap 为空）');
assert.equal(first.units.length, m1.units.length, '本回放无地面单位：首批单位数 == 最终单位数');
assert.deepEqual(J(m1), J(m0), '流式最终产物必须与非流式逐项一致');

/* ---- 3. 进度单调 ---- */
{
  let prev = -1;
  for (const p of progressLog) {
    assert.ok(p.pct >= prev - 1e-9, `进度回退：${prev} → ${p.pct}（${p.phase}）`);
    prev = p.pct;
  }
  assert.equal(progressLog[progressLog.length - 1].phase, 'done');
}

/* ---- 4. store 路径分片合并 == 直出（模拟 wrpl-worker 的 sendMission 分片） ---- */
function feedParts(target, st) {
  const merge = (key, data) => I.mergePartInto(target, key, data, st);
  merge('meta', m0.meta);
  // own 按 sendOwn 的 4 组分片
  const groups = [['t0', 'hz', 'n'], ['x', 'y', 'z'], ['ias', 'tas', 'mach', 'hdg'],
                  ['roll', 'pitch', 'g', 'aoa', 'ammo', 'fuel', 'vy', 'throttle']];
  for (const keys of groups) {
    const part = {};
    for (const k of keys) part[k] = m0.own[k];
    merge('own', part);
  }
  // units 切两片
  const half = Math.ceil(m0.units.length / 2);
  merge('units', m0.units.slice(0, half));
  merge('units', m0.units.slice(half));
  for (const k of ['events', 'shots', 'runways', 'airfields', 'missiles']) merge(k, m0[k]);
  // __attitude 按 uid 切两片
  const att = m0.__attitude;
  const uids = Object.keys(att.units);
  const pack = (subset) => ({
    note: att.note, secPerTick: att.secPerTick, tick0: att.tick0, dt: att.dt,
    units: Object.fromEntries(subset.map((u) => [u, att.units[u]]))
  });
  merge('__attitude', pack(uids.slice(0, Math.ceil(uids.length / 2))));
  merge('__attitude', pack(uids.slice(Math.ceil(uids.length / 2))));
  merge('terrain', m0.terrain);
  merge('names', m0.names);
}
/* worker 的 sendMission 发 __attitude 时 head 只带 note/secPerTick/tick0/dt（不带 points/uidCount），
 * 所以「分片合并后」的期望值也要去掉这两个键 —— 与真实 worker→主线程口径一致。 */
function expectMerged(m) {
  const o = J(m);
  if (o.__attitude) { delete o.__attitude.points; delete o.__attitude.uidCount; }
  return o;
}

{
  const store = I.recvPartStore();
  feedParts(store, null);
  const assembled = I.assembleMission(store);
  assert.deepEqual(J(assembled), expectMerged(m0), 'store 分片合并结果必须与 parseMain 直出一致');
}

/* ---- 5. 流式合并进首批对象 ---- */
{
  let fb = null;
  await I.parseMain(good, { firstBatch(m) { fb = m; } });
  const st = { unitsReplaced: false, ownReplaced: false, streaming: true };
  const nFirstUnits = fb.units.length;
  feedParts(fb, st);
  assert.equal(fb.units.length, m0.units.length,
    `首个 units 分片必须替换首批临时 units（不重复）：${fb.units.length} != ${m0.units.length}（首批 ${nFirstUnits}）`);
  assert.equal(fb.terrain, null, '流式时 worker 的 terrain 占位(null)不覆盖页面字段');
  assert.deepEqual(fb.names, {}, 'names 占位不覆盖');
  assert.deepEqual(expectMerged(fb), expectMerged(m0), '流式合并完成 == parseMain 直出');
  // 幂等：重复合并同一 meta 不改变结果
  I.mergePartInto(fb, 'meta', m0.meta, st);
  I.mergePartInto(fb, 'meta', m0.meta, st);
  assert.deepEqual(J(fb.meta), J(m0.meta), '重复合并 meta 幂等');
}

/* ---- 6. 首批后失败（验收钩子） ---- */
{
  let fired = false;
  await assert.rejects(
    I.parseMain(good, { firstBatch() { fired = true; }, debugFailAfterFirstBatch: true }),
    /debugFailAfterFirstBatch/
  );
  assert.ok(fired, '失败前首批必须已经发出（回滚路径的前提）');
}

/* ---- 7. 坏文件 ---- */
await assert.rejects(I.parseMain(buildDemoWrpl('bad-magic'), {}),
  (e) => e && e.code === 'unsupported-format');
await assert.rejects(I.parseMain(buildDemoWrpl('bad-results'), {}), /BLK/);

/* ---- 8. cancel 空调用 ---- */
assert.doesNotThrow(() => WRPLParse.cancel());

console.log('streaming parse ok（8 组验收全部通过）');
