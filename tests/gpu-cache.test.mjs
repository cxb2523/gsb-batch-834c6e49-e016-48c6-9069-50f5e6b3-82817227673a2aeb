// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
// GPU纹理缓存槽位回收与重传验收测试
//
// 覆盖题面验收点：
//  A1 远处分块被回收后再次靠近可重传（重新分配槽位、更新偏移量）
//  A2 回收后分块标记未就绪，重传前不读取旧槽位数据
//  A3 同一分块排队期间重复请求不重复占用槽位
//  A4 回收与上传并发时正在写入的槽位不被回收，写入完成后数据完整
//  A5 销毁后清理槽位表与待上传队列，无残留写入已释放纹理
//  A6 可见分块在回收前后渲染数据一致
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DataArrayTexture } from 'three';
import { SplatGpuCache } from '../src/reall3d/meshs/splatmesh/SplatGpuCache.ts';
import { Events } from '../src/reall3d/events/Events.ts';
import { GetDataArrayTexture } from '../src/reall3d/events/EventConstants.ts';

const WIDTH = 1024;
const HEIGHT = 4; // 每层可容纳 1024*4/2 = 2048 个splat
const DEPTH = 4;
const SLOT_CAPACITY = (WIDTH * HEIGHT) / 2;

/** 构造测试用分块；每个分块的32字节记录用 fileKey 填充，便于校验GPU内容归属 */
function makeFile(fileKey, downloadCount, targetLayer = -1) {
    const downloadData = new Uint8Array(downloadCount * 32);
    downloadData.fill(0xaa);
    return { fileKey, downloadCount, downloadData, targetLayer, textureReady: false };
}

/** 从纹理读取槽位内容的首字节，用于判断该槽位当前归属 */
function slotFirstByte(texture, layer) {
    const data = new Uint8Array(texture.image.data.buffer);
    const offsetBytes = Math.floor((SLOT_CAPACITY * layer * 32) / 2);
    return data[offsetBytes];
}

function makeCache(events, { fullCache = false, dataCount = 0 } = {}) {
    const texture = new DataArrayTexture(new Uint32Array(WIDTH * HEIGHT * DEPTH * 4), WIDTH, HEIGHT, DEPTH);
    events.on(GetDataArrayTexture, () => texture);
    const cache = new SplatGpuCache(events, WIDTH, HEIGHT, DEPTH, dataCount, fullCache);
    // 测试辅助：立即完成当前挂起的GPU上传（模拟渲染循环推进）
    cache.flushPendingUploads = () => cache.flushPendingUpload();
    return { cache, texture };
}

function makeFileWithMagic(fileKey, downloadCount, targetLayer = -1) {
    const downloadData = new Uint8Array(downloadCount * 32);
    downloadData.fill(0xaa);
    // 首字节写入 fileKey 的数字标识，用于判断槽位内容归属
    const tag = parseInt(fileKey.replace(/\D/g, ''), 10) || 1;
    downloadData.fill(tag & 0xff, 0, 1);
    return { fileKey, downloadCount, downloadData, targetLayer, textureReady: false };
}

test('A1: 回收后重传重新分配槽位并更新偏移量', async () => {
    const events = new Events();
    const { cache, texture } = makeCache(events);
    const file = makeFile('f0', 100, 0);

    assert.equal(await cache.uploadSplatFile(file), true);
    assert.equal(file.textureReady, true);
    const oldOffset = file.offset;
    assert.equal(oldOffset, 0);
    assert.equal(cache.getSlot('f0'), 0);

    // 回收
    assert.equal(cache.releaseSlot('f0'), true);
    assert.equal(file.textureReady, false, '回收后必须标记未就绪');
    assert.equal(file.offset, undefined, '回收后必须清除旧偏移量');
    assert.equal(cache.getSlot('f0'), -1);
    assert.equal(cache.hasSlot('f0'), false);

    // 再次靠近：重新分配另一个槽位后重传
    const newData = new Uint8Array(100 * 32);
    newData.fill(0xbb);
    file.downloadData = newData;
    file.downloadCount = 100;
    file.targetLayer = 2;
    file.status = 0;

    assert.equal(await cache.uploadSplatFile(file), true);
    assert.equal(file.textureReady, true);
    assert.equal(cache.getSlot('f0'), 2);
    assert.equal(file.offset, (WIDTH * HEIGHT * 2) / 2, '偏移量应按新槽位换算');
    assert.notEqual(file.offset, oldOffset);

    // 数据落在新偏移位置
    const raw = new Uint8Array(texture.image.data.buffer);
    assert.equal(raw[file.offset * 32], 0xbb);
    // 旧位置不再被该分块标记为就绪依赖
    assert.equal(slotFirstByte(texture, 0) === 0xbb, false);

    cache.dispose();
});

test('A2: 回收后未重传前保持未就绪，且无槽位', async () => {
    const events = new Events();
    const { cache } = makeCache(events);
    const file = makeFile('f1', 64, 1);

    assert.equal(await cache.uploadSplatFile(file), true);
    assert.equal(file.textureReady, true);

    cache.releaseSlot('f1');
    assert.equal(file.textureReady, false);
    assert.equal(cache.hasSlot('f1'), false);
    assert.equal(cache.getSlot('f1'), -1);

    // 未分配槽位时重复上传请求不会写入，也不会误标就绪
    file.targetLayer = -1;
    file.downloadData = new Uint8Array(64 * 32);
    const before = file.textureReady;
    assert.equal(await cache.uploadSplatFile(file), false);
    assert.equal(file.textureReady, before);

    cache.dispose();
});

/** 让出若干微任务，使串行上传链推进到"写入中"状态 */
async function tick(times = 4) {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

test('A3: 同一分块排队期间重复请求不重复占用槽位', async () => {
    const events = new Events();
    const { cache } = makeCache(events);
    const file = makeFile('f2', 32, 3);

    DataArrayTexture.autoUpdate = false; // 阻塞写入完成，制造"排队/写入中"窗口

    const p1 = cache.uploadSplatFile(file);
    const p2 = cache.uploadSplatFile(file);
    const p3 = cache.uploadSplatFile(file);
    await tick();

    assert.equal(cache.getOccupiedSlotCount() <= 1, true, '同一分块不会因重复请求占用多个槽位');
    assert.equal(cache.getPendingCount(), 1, '同一分块在排队/写入期间只占一个待处理项');

    // 第二次、第三次请求应直接返回 false，不产生额外占位
    assert.equal(await p2, false);
    assert.equal(await p3, false);

    DataArrayTexture.autoUpdate = true;
    await cache.flushPendingUploads();
    assert.equal(await p1, true);
    assert.equal(cache.getOccupiedSlotCount(), 1);
    assert.equal(file.textureReady, true);

    cache.dispose();
});

test('A4: 回收与上传并发时正在写入的槽位不被回收，写入完成后数据完整', async () => {
    const events = new Events();
    const { cache, texture } = makeCache(events);
    const file = makeFile('f3', 128, 0);
    const beforeData = file.downloadData.slice(0, 128 * 32);

    DataArrayTexture.autoUpdate = false;
    const uploadPromise = cache.uploadSplatFile(file);
    await tick();

    // 写入进行中，此时其槽位应处于写入状态，回收请求被延迟
    assert.equal(cache.isWriting(0), true);
    assert.equal(cache.releaseSlot('f3'), false, '写入中的槽位不能立即回收');
    assert.equal(cache.hasSlot('f3'), true, '写入期间仍保持占用，避免槽位被抢占');

    // 数据在纹理中已完整写入（写入 + 上传才会置就绪）
    DataArrayTexture.autoUpdate = true;
    await cache.flushPendingUploads();
    await uploadPromise;

    // 写入完成后延迟回收生效：分块未就绪、槽位被释放
    assert.equal(file.textureReady, false, '延迟回收后不应标记就绪');
    assert.equal(cache.hasSlot('f3'), false, '延迟回收最终释放槽位');

    // 可见的近处分块数据一致：完整写入了全部128个splat
    const raw = new Uint8Array(texture.image.data.buffer);
    assert.deepEqual(raw.slice(0, 128 * 32), beforeData, '写入的数据完整无缺');

    cache.dispose();
});

test('A5: 销毁后清理槽位表与待上传队列，无残留写入', async () => {
    const events = new Events();
    const { cache, texture } = makeCache(events);
    const f0 = makeFileWithMagic('g0', 64, 0);
    const f1 = makeFileWithMagic('g1', 64, 1);

    // 先完成一次正常上传
    assert.equal(await cache.uploadSplatFile(f0), true);
    assert.equal(cache.getOccupiedSlotCount(), 1);

    // 制造挂起上传
    DataArrayTexture.autoUpdate = false;
    const pending = cache.uploadSplatFile(f1);
    await tick();
    assert.equal(cache.getPendingCount(), 1);

    cache.dispose();
    assert.equal(cache.getPendingCount(), 0, '销毁后待上传队列应为空');
    assert.equal(cache.getOccupiedSlotCount(), 0, '销毁后槽位表应为空');
    assert.equal(cache.hasSlot('g0'), false);
    assert.equal(f0.textureReady, false, '销毁后清除就绪标记');

    // 挂起的上传应被唤醒并返回 false，不再写入纹理
    DataArrayTexture.autoUpdate = true;
    assert.equal(await pending, false, '销毁后挂起上传应被中止');

    const snapshot = new Uint8Array(texture.image.data.buffer).slice();
    // 销毁后新的上传请求一律拒绝
    const f2 = makeFileWithMagic('g2', 64, 2);
    assert.equal(await cache.uploadSplatFile(f2), false);
    assert.deepEqual(new Uint8Array(texture.image.data.buffer), snapshot, '销毁后不应再写入纹理');

    cache.dispose(); // 幂等
});

test('A6: 可见分块在回收远处分块前后数据一致', async () => {
    const events = new Events();
    const { cache, texture } = makeCache(events);

    const near = makeFile('near', 256, 0);
    const far = makeFile('far', 256, 1);

    assert.equal(await cache.uploadSplatFile(near), true);
    assert.equal(await cache.uploadSplatFile(far), true);

    const nearOffset = near.offset;
    const nearSlot = cache.getSlot('near');
    const nearBytes = new Uint8Array(texture.image.data.buffer).slice(nearOffset * 32, (nearOffset + 256) * 32);

    // 回收远处分块
    assert.equal(cache.releaseSlot('far'), true);

    // 近处分块数据与槽位保持不变
    assert.equal(near.textureReady, true, '近处分块保持就绪');
    assert.equal(cache.getSlot('near'), nearSlot);
    assert.equal(near.offset, nearOffset);
    const afterBytes = new Uint8Array(texture.image.data.buffer).slice(nearOffset * 32, (nearOffset + 256) * 32);
    assert.deepEqual(afterBytes, nearBytes, '近处分块渲染数据在回收前后一致');
    assert.equal(far.textureReady, false);

    cache.dispose();
});

test('A1+: 回收远处分块后可重新占用同一槽位并正确取数', async () => {
    const events = new Events();
    const { cache, texture } = makeCache(events);

    const a = makeFileWithMagic('a1', 128, 0);
    assert.equal(await cache.uploadSplatFile(a), true);
    const aOffset = a.offset;

    // 回收 a1，再把槽位0分配给 a2
    assert.equal(cache.releaseSlot('a1'), true);
    assert.equal(a.textureReady, false);

    const b = makeFileWithMagic('b1', 200, 0);
    assert.equal(await cache.uploadSplatFile(b), true);
    assert.equal(b.textureReady, true);
    assert.equal(b.offset, aOffset, '复用同一槽位时偏移量一致');
    assert.equal(cache.getSlot('b1'), 0);
    assert.equal(cache.getSlot('a1'), -1, '旧分块不再占用槽位');

    // 纹理首字节应属于 b1
    const raw = new Uint8Array(texture.image.data.buffer);
    assert.equal(raw[b.offset * 32], parseInt('1', 10) & 0xff, '槽位内容已更新为新分块');

    cache.dispose();
});
