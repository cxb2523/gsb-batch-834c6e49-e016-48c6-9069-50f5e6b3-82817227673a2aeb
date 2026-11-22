// ==============================================
// Copyright (c) 2025 reall3d.com, MIT license
// ==============================================
import { DataArrayTexture } from 'three';
import { GetDataArrayTexture, OnSplatLodFullUploaded } from '../../events/EventConstants';
import { Events } from '../../events/Events';
import { SplatFile } from '../../modeldata/SplatTiles';
import { calcPartDepthRange, extractSplatXYZ } from '../../utils/CommonUtils';

/** GPU上传等待上限，避免渲染循环暂停或上下文丢失时上传永久悬挂 */
const TextureUpdateTimeout = 1000;

/**
 * 大场景GPU纹理缓存（数组纹理的槽位管理）
 *
 * 槽位（layer）与分块文件一一对应，偏移量 offset 由槽位换算：offset = width * height * layer / 2。
 * - 分配：上传前由调度端（WorkerLod）分配槽位并写入 SplatFile.targetLayer，本类按该槽位写入并登记占位；
 * - 回收：releaseSlot 清除占位与就绪标记，重传时按新槽位重算偏移量；
 * - 去重：同一分块在排队或写入期间重复请求时不会重复占用槽位（pendingUploads + fileSlotMap）；
 * - 并发：正在写入的槽位不会被回收，回收请求延迟到写入完成后执行（writingSlot + deferredReleases）；
 * - 销毁：dispose 清空槽位表与待上传队列，唤醒等待GPU回调的挂起项并清除定时器，避免销毁后写入已释放纹理。
 */
export class SplatGpuCache {
    protected disposed = false;
    protected events: Events;
    private layerWidth: number;
    private layerHeight: number;
    private layerDepth: number;
    private fullCache: boolean;
    private texture: DataArrayTexture;
    private offset: number = 0;
    private dataCount: number = 0;

    /** 槽位表：layer -> 分块 */
    private slotFiles: (SplatFile | null)[] = [];
    /** 分块fileKey -> 槽位，用于去重与释放 */
    private fileSlotMap: Map<string, number> = new Map();
    /** 排队或写入中的分块（同一分块重复请求不重复占位） */
    private pendingUploads: Set<string> = new Set();
    /** 排队期间被回收的分块，轮到执行时直接跳过 */
    private cancelledUploads: Set<string> = new Set();
    /** 正在写入的槽位，-1表示无 */
    private writingSlot: number = -1;
    /** 写入期间收到回收请求的分块，写入完成后立即释放 */
    private deferredReleases: Set<string> = new Set();
    /** 等待GPU上传回调的挂起项与超时定时器 */
    private pendingResolvers: Set<Function> = new Set();
    private pendingTimers: Set<any> = new Set();
    /** 串行化上传，保证 onUpdate 单回调与偏移递增顺序正确 */
    private uploadChain: Promise<any> = Promise.resolve();
    /** 纹理全量上传完成后的回调，销毁时注销 */
    private onTextureFullUploaded: Function;

    constructor(events: Events, width: number, height: number, depth: number, dataCount: number, fullCache: boolean) {
        const that = this;
        that.events = events;
        that.layerWidth = width;
        that.layerHeight = height;
        that.layerDepth = Math.max(0, depth | 0);
        that.dataCount = dataCount;
        that.fullCache = fullCache;
        that.texture = events.fire(GetDataArrayTexture);
        that.onTextureFullUploaded = () => {
            // 销毁后不再触碰纹理，避免回调写入已释放资源
            if (that.disposed || !that.texture) return;
            that.texture.image && (that.texture.image.data = null);
        };
        events.on(OnSplatLodFullUploaded, that.onTextureFullUploaded);
    }

    /**
     * 上传分块数据到GPU纹理（串行执行）
     * @returns 本次是否真正完成GPU写入；已就绪、重复请求、无槽位、已销毁时返回 false
     */
    public uploadSplatFile(file: SplatFile): Promise<boolean> {
        const that = this;
        if (that.disposed || !file || !file.fileKey) return Promise.resolve(false);

        const fileKey = file.fileKey;
        // 同一分块排队/写入期间不重复入队，避免重复占用槽位
        if (that.pendingUploads.has(fileKey)) return Promise.resolve(false);
        that.pendingUploads.add(fileKey);
        that.cancelledUploads.delete(fileKey);

        const task = async (): Promise<boolean> => {
            // 排队期间已被回收/取消：跳过，释放占位
            if (that.disposed || that.cancelledUploads.has(fileKey)) {
                that.pendingUploads.delete(fileKey);
                that.cancelledUploads.delete(fileKey);
                return false;
            }
            try {
                return that.fullCache ? await that.uploadSplatFileFull(file) : await that.uploadSplatFilePart(file);
            } finally {
                that.pendingUploads.delete(fileKey);
                that.cancelledUploads.delete(fileKey);
            }
        };

        const result = that.uploadChain.then(task, task);
        that.uploadChain = result.then(
            () => true,
            () => true,
        );
        return result;
    }

    /**
     * 全量缓存模式：按递增偏移紧凑排列，纹理容量足够容纳所有分块，不做槽位回收
     */
    protected async uploadSplatFileFull(file: SplatFile): Promise<boolean> {
        const that = this;
        if (that.disposed || file.textureReady) return false;

        const imageData = that.texture?.image?.data;
        if (!imageData || !file.downloadData || !file.downloadCount) return false;

        const offset = that.offset;
        if (offset + file.downloadCount > that.dataCount) return false; // 容量保护

        file.textureReady = false;
        const { startDepth, endDepth } = calcPartDepthRange(that.layerWidth, that.layerHeight, offset, file.downloadCount);
        const downloadData = file.downloadData.subarray(0, file.downloadCount * 32);
        const ui8sTex = new Uint8Array(imageData.buffer);
        if ((offset + file.downloadCount) * 32 > ui8sTex.byteLength) return false;
        ui8sTex.set(downloadData, offset * 32);

        const slots: number[] = [];
        for (let i = startDepth; i <= endDepth; i++) slots.push(i);
        const updated = await that.waitTextureUpdate(slots);
        if (!updated || that.disposed) {
            file.textureReady = false; // 写入未完成或已销毁，保持未就绪
            return false;
        }

        file.xyz = extractSplatXYZ(downloadData);
        file.downloadData = null;

        file.lastTime = Math.max(Date.now(), file.lastTime);
        file.offset = offset;
        file.textureReady = true;
        that.offset += file.downloadCount;
        that.offset >= that.dataCount && that.events && that.events.tryFire(OnSplatLodFullUploaded);
        return true;
    }

    /**
     * 分块缓存模式：一个分块占用一个槽位
     */
    protected async uploadSplatFilePart(file: SplatFile): Promise<boolean> {
        const that = this;
        if (that.disposed) return false;

        const fileKey = file.fileKey;
        if (!fileKey) return false;

        const slot = that.acquireSlot(file);
        if (slot < 0) return false; // 无可用槽位（调度端尚未分配）

        // 已就绪且槽位未变、且槽位仍归本分块所有，无需重复写入
        if (file.textureReady && file.offset === that.slotOffset(slot) && that.slotFiles[slot] === file) return false;

        that.writingSlot = slot;
        file.textureReady = false; // 写入期间一律未就绪，渲染端不会读取半写槽位

        let uploaded = false;
        try {
            uploaded = await that.writeSlot(file, slot);
        } finally {
            if (that.writingSlot === slot) that.writingSlot = -1;
        }

        // 写入期间被请求回收：写入完成后立即释放，避免槽位被已失效分块长期占用
        if (that.deferredReleases.has(fileKey)) {
            that.deferredReleases.delete(fileKey);
            that.releaseSlot(fileKey);
            return false;
        }

        if (!uploaded || that.disposed) {
            file.textureReady = false;
            return false;
        }

        // 写入期间槽位可能已被改派给其他分块，此时不能把本分块标记为就绪
        if (that.slotFiles[slot] !== file || file.targetLayer !== slot) {
            file.textureReady = false;
            return false;
        }

        file.offset = that.slotOffset(slot);
        file.lastTime = Math.max(Date.now(), file.lastTime);
        file.downloadData = null; // 数据已写入GPU，释放CPU侧副本
        file.textureReady = true;
        return true;
    }

    /**
     * 写入指定槽位
     */
    protected async writeSlot(file: SplatFile, slot: number): Promise<boolean> {
        const that = this;
        const dataArrayTexture = that.texture;
        const imageData = dataArrayTexture?.image?.data;
        if (that.disposed || !imageData) return false;

        const downloadCount = file.downloadCount || 0;
        if (!downloadCount || !file.downloadData || file.downloadData.byteLength < downloadCount * 32) return false;

        const offset = that.slotOffset(slot);
        const downloadData = file.downloadData.subarray(0, downloadCount * 32);
        const ui8sTex = new Uint8Array(imageData.buffer);
        if ((offset + downloadCount) * 32 > ui8sTex.byteLength) return false; // 越界保护
        ui8sTex.set(downloadData, offset * 32);

        const updated = await that.waitTextureUpdate([slot]);
        if (!updated || that.disposed) return false;
        return true;
    }

    /**
     * 等待纹理上传完成；dispose 时统一唤醒全部挂起项，避免残留回调
     */
    private waitTextureUpdate(slots: number[]): Promise<boolean> {
        const that = this;
        const dataArrayTexture = that.texture;
        if (that.disposed || !dataArrayTexture) return Promise.resolve(false);

        return new Promise<boolean>(resolve => {
            let done = false;
            let timer: any = null;
            const finish = (ok: boolean) => {
                if (done) return;
                done = true;
                that.pendingResolvers.delete(finish);
                if (timer) {
                    clearTimeout(timer);
                    that.pendingTimers.delete(timer);
                    timer = null;
                }
                dataArrayTexture.onUpdate = null;
                resolve(ok && !that.disposed);
            };

            that.pendingResolvers.add(finish);
            dataArrayTexture.onUpdate = () => finish(true);

            // 渲染循环暂停时也能继续流程；仅作兜底，不产生残留
            timer = setTimeout(() => finish(true), TextureUpdateTimeout);
            that.pendingTimers.add(timer);

            for (const layer of slots) dataArrayTexture.addLayerUpdate(layer);
            dataArrayTexture.needsUpdate = true;
        });
    }

    /**
     * 槽位起始偏移（单位：splat）
     */
    private slotOffset(slot: number): number {
        return (this.layerWidth * this.layerHeight * slot) / 2;
    }

    /**
     * 确认分块当前应占用的槽位；同一分块始终映射到同一槽位
     */
    private acquireSlot(file: SplatFile): number {
        const that = this;
        const fileKey = file.fileKey;
        const slot = file.targetLayer;
        if (slot === undefined || slot === null || slot < 0 || slot >= that.layerDepth) return -1;

        const exists = that.fileSlotMap.get(fileKey);
        if (exists === slot && that.slotFiles[slot] === file) return slot;

        // 调度端改派了槽位：解除旧占位（旧槽位留给后续分块按需占位）
        const oldFile = exists !== undefined ? that.slotFiles[exists] : null;
        if (exists !== undefined && exists !== slot && oldFile === file) {
            that.slotFiles[exists] = null;
        }

        // 若目标槽位仍被其他分块占用，且该槽位正在写入，则不能抢占；否则旧占位作废
        const occupant = that.slotFiles[slot];
        if (occupant && occupant !== file) {
            if (that.isWriting(slot)) return -1;
            occupant.textureReady = false; // 槽位已改派，旧数据视为失效
            that.fileSlotMap.delete(occupant.fileKey);
        }

        that.slotFiles[slot] = file;
        that.fileSlotMap.set(fileKey, slot);
        return slot;
    }

    /**
     * 回收分块占用的槽位并清除就绪标记与旧偏移量；正在写入的槽位延迟释放
     * @returns 是否已释放（false 表示无占位，或正在写入已延迟）
     */
    public releaseSlot(fileKey: string): boolean {
        const that = this;
        if (that.disposed || !fileKey) return false;

        const slot = that.fileSlotMap.get(fileKey);
        if (slot === undefined) return false; // 无占位，无需处理

        if (that.writingSlot === slot) {
            that.deferredReleases.add(fileKey); // 正在写入，写完再释放
            return false;
        }

        const file = that.slotFiles[slot];
        that.slotFiles[slot] = null;
        that.fileSlotMap.delete(fileKey);
        that.deferredReleases.delete(fileKey);

        if (file) {
            file.textureReady = false;
            file.offset = undefined;
        }
        // 若该分块还在队列里等待，标记取消，轮到执行时直接跳过
        if (that.pendingUploads.has(fileKey)) that.cancelledUploads.add(fileKey);
        return true;
    }

    /** 分块当前占用的槽位，未占用返回 -1 */
    public getSlot(fileKey: string): number {
        return this.fileSlotMap.get(fileKey) ?? -1;
    }

    /** 分块是否已有槽位 */
    public hasSlot(fileKey: string): boolean {
        return this.fileSlotMap.has(fileKey);
    }

    /** 分块是否在排队或写入中 */
    public isPending(fileKey: string): boolean {
        return this.pendingUploads.has(fileKey);
    }

    /** 槽位总数 */
    public getSlotCount(): number {
        return this.layerDepth;
    }

    /** 已占用槽位数量 */
    public getOccupiedSlotCount(): number {
        return this.fileSlotMap.size;
    }

    /** 待上传队列长度 */
    public getPendingCount(): number {
        return this.pendingUploads.size;
    }

    /** 指定槽位是否正在写入 */
    public isWriting(slot: number): boolean {
        return this.writingSlot === slot;
    }

    /**
     * 立即完成当前挂起的纹理上传（仅用于测试/特殊渲染循环驱动场景）
     * 正常情况下由纹理 onUpdate 回调或超时兜底完成
     */
    public flushPendingUpload(): boolean {
        const that = this;
        if (that.disposed) return false;
        const texture = that.texture as any;
        if (typeof texture?.flushUpdate === 'function') {
            texture.flushUpdate();
            return true;
        }
        return false;
    }

    /**
     * 销毁：清理槽位表与待上传队列，唤醒并中止所有等待GPU回调的上传
     */
    public dispose() {
        const that = this;
        if (that.disposed) return;
        that.disposed = true;

        // 清理等待GPU上传的定时器，避免销毁后仍有定时器触发
        that.pendingTimers.forEach(timer => clearTimeout(timer));
        that.pendingTimers.clear();

        // 唤醒全部挂起等待，避免留下永不完成的回调
        const resolvers = [...that.pendingResolvers];
        that.pendingResolvers.clear();
        resolvers.forEach(fn => {
            try {
                fn(false);
            } catch (e) {
                // ignore
            }
        });

        // 清理槽位表，并清除分块就绪标记（避免销毁后仍被认为可渲染）
        for (let i = 0; i < that.slotFiles.length; i++) {
            const file = that.slotFiles[i];
            if (file) {
                file.textureReady = false;
                file.offset = undefined;
            }
            that.slotFiles[i] = null;
        }
        that.slotFiles.length = 0;
        that.fileSlotMap.clear();
        that.pendingUploads.clear();
        that.cancelledUploads.clear();
        that.deferredReleases.clear();
        that.writingSlot = -1;

        // 注销纹理全量上传回调，防止销毁后回调再次写纹理
        if (that.events && that.onTextureFullUploaded) that.events.off(OnSplatLodFullUploaded);
        that.onTextureFullUploaded = null;
        that.texture = null;
        that.events = null;
    }
}
