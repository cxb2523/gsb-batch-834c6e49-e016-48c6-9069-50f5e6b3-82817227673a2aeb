// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
// 上传队列与槽位分配联动验收测试（大场景 useGpuCache 路径）
//
// 覆盖：
//  A3 上传队列对同一分块的重复请求合并为一次，不重复占用槽位
//  A5 销毁时清理待上传队列，挂起上传被中止且不再写入已释放纹理
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DataArrayTexture } from 'three';
import { Events } from '../src/reall3d/events/Events.ts';
import { setupSplatMesh } from '../src/reall3d/meshs/splatmesh/SetupSplatMesh.ts';
import {
    CreateSplatMaterial,
    CreateSplatUniforms,
    ComputeTextureWidthHeight,
    GetDataArrayTexture,
    GetLodDataInfo,
    GetMeta,
    GetOptions,
    GetSortWorker,
    IsBigSceneMode,
    NotifyWkA01SetTextureSize,
    SplatUploadTextureGpuCache,
    SplatMaterialDispose,
} from '../src/reall3d/events/EventConstants.ts';

const WIDTH = 1024;
const HEIGHT = 4;
const DEPTH = 4;

async function setupGpuCacheScene(events, texture) {
    events.on(GetOptions, () => ({ bigSceneMode: true, depthTest: true }));
    events.on(GetMeta, () => ({ useGpuCache: true }));
    events.on(IsBigSceneMode, () => true);
    events.on(GetLodDataInfo, async () => ({ totalCount: 1000, lodTargetsTotalCount: 1000, lodTargetsFileCount: 4, maxFileSplatCount: 500 }));
    events.on(ComputeTextureWidthHeight, () => ({ texwidth: WIDTH, texheightary: HEIGHT, texdepth: DEPTH, fullCache: false }));
    events.on(NotifyWkA01SetTextureSize, () => {});
    events.on(CreateSplatUniforms, () => ({}));
    events.on(SplatMaterialDispose, () => {}, true);

    // SetupSplatMesh 构造缓存纹理时通过该事件获取纹理；返回我们持有的实例以便断言
    events.on(GetDataArrayTexture, () => texture);

    const material = await events.fire(CreateSplatMaterial);
    assert.ok(material);
    return { texture };
}

function makeFile(fileKey, targetLayer, count = 64) {
    const downloadData = new Uint8Array(count * 32);
    const tag = parseInt(fileKey.replace(/\D/g, ''), 10) || 1;
    downloadData.fill(tag & 0xff);
    return { fileKey, downloadCount: count, downloadData, targetLayer, textureReady: false };
}

const tick = async (n = 6) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 构造被测事件总线，并注入最小依赖（含排序worker） */
function setupEvents() {
    const events = new Events();
    events.on(GetSortWorker, () => ({ onmessage: null, postMessage() {}, terminate() {} }));
    setupSplatMesh(events);
    return events;
}

test('A3(队列): 同一分块入队期间重复请求只占一个槽位', async () => {
    const events = setupEvents();
    const texture = new DataArrayTexture(new Uint32Array(WIDTH * HEIGHT * DEPTH * 4), WIDTH, HEIGHT, DEPTH);
    await setupGpuCacheScene(events, texture);
    const file = makeFile('q1', 0, 64);

    // 让GPU上传不自动完成，形成排队窗口
    DataArrayTexture.autoUpdate = false;
    const updatesBefore = texture.updateCount;

    events.fire(SplatUploadTextureGpuCache, file);
    events.fire(SplatUploadTextureGpuCache, file);
    events.fire(SplatUploadTextureGpuCache, file);
    await tick();

    // 完成挂起上传
    DataArrayTexture.autoUpdate = true;
    typeof texture.flushUpdate === 'function' && texture.flushUpdate();
    await tick(10);

    assert.equal(file.textureReady, true, '合并后的请求最终全部处理完成，分块就绪');
    // 三次重复请求只产生一次GPU写入
    assert.equal(texture.updateCount - updatesBefore, 1, '同一分块重复请求只执行一次写入，不重复占位');
    // 槽位内容归属该分块
    const raw = new Uint8Array(texture.image.data.buffer);
    assert.equal(raw[file.offset * 32], parseInt('1', 10) & 0xff);

    events.fire(SplatMaterialDispose);
});

test('A5(队列): 销毁时清理待上传队列，挂起上传被中止', async () => {
    const events = setupEvents();
    const texture = new DataArrayTexture(new Uint32Array(WIDTH * HEIGHT * DEPTH * 4), WIDTH, HEIGHT, DEPTH);
    await setupGpuCacheScene(events, texture);

    DataArrayTexture.autoUpdate = false;
    const file = makeFile('q2', 1, 64);
    events.fire(SplatUploadTextureGpuCache, file);
    await tick();

    // 销毁（触发缓存dispose，清空队列并中止挂起上传）
    events.fire(SplatMaterialDispose);
    await tick(10);

    assert.equal(file.textureReady, false, '销毁后分块不应被标记就绪');
});
