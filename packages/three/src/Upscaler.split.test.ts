import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { Upscaler } from './Upscaler';

//* The three adapter driving split frames: dispatchGuides/dispatchUpscale
//* through Upscaler must follow the core's state contract — a half-frame is
//* never silently carried into the next frame, and configure/dispose reset it.

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function fixture() {
    const lost = deferred<GPUDeviceLostInfo>();
    const jobs: Array<{ label: string; resolve(value: GPUComputePipeline): void; reject(error: unknown): void }> = [];
    const resource = (descriptor: { size?: number; width?: number; height?: number } = {}) => ({
        width: descriptor.width ?? 16, height: descriptor.height ?? 16, sampleCount: 1,
        format: 'rgba16float', createView: () => ({}), destroy: vi.fn(),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4), unmap: vi.fn(),
        getBindGroupLayout: () => ({}),
    });
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: lost.promise, features: new Set(),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
        createShaderModule: vi.fn(resource),
        createComputePipelineAsync: vi.fn((descriptor: GPUComputePipelineDescriptor) =>
            new Promise<GPUComputePipeline>((resolve, reject) => jobs.push({ label: descriptor.label!, resolve, reject }))),
        createBuffer: resource, createSampler: resource, createTexture: resource,
        createBindGroup: resource, createCommandEncoder: vi.fn(() => encoder),
    };
    const renderer = {
        backend: { device, get: () => ({ texture: resource() }) }, initTexture() {},
    } as unknown as WebGPURenderer;
    const upscaler = new Upscaler({ renderer });
    const finish = async () => {
        for (let i = 0; i < 30; i++) {
            jobs.splice(0).forEach(job => job.resolve(resource() as unknown as GPUComputePipeline));
            await Promise.resolve();
        }
    };
    return { upscaler, device, finish };
}

describe('Upscaler split-frame driving', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2 });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    const configured = async () => {
        const f = fixture();
        f.upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'temporal' });
        const ready = f.upscaler.init();
        await f.finish();
        await ready;
        return f;
    };

    it('runs a split frame and refuses anything that would skip the late stage', async () => {
        const { upscaler } = await configured();
        const color = new Texture(), depth = new Texture(), velocity = new Texture();
        const camera = new PerspectiveCamera();

        expect(() => upscaler.dispatchUpscale({ color }, camera)).toThrow(/dispatchGuides/);

        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.guidesPending).toBe(true);
        expect(() => upscaler.dispatchGuides({ depth, velocity }, camera)).toThrow(/dispatchUpscale/);
        expect(() => upscaler.dispatch({ color, depth, velocity }, camera)).toThrow(/split frame/);
        expect(upscaler.guidesPending).toBe(true);

        upscaler.dispatchUpscale({ color }, camera);
        expect(upscaler.guidesPending).toBe(false);

        // The next frame is free to go monolithic or split again.
        upscaler.dispatch({ color, depth, velocity }, camera);
        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.guidesPending).toBe(true);
        upscaler.dispatchUpscale({ color }, camera);
        expect(upscaler.guidesPending).toBe(false);
    });

    it('configure() during a split frame drops the half-frame safely', async () => {
        const { upscaler } = await configured();
        const color = new Texture(), depth = new Texture(), velocity = new Texture();
        const camera = new PerspectiveCamera();

        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.guidesPending).toBe(true);

        upscaler.configure({ displayWidth: 64, displayHeight: 64, path: 'temporal' });
        expect(upscaler.guidesPending).toBe(false);

        // A monolithic dispatch works right away; a new split starts clean.
        upscaler.dispatch({ color, depth, velocity }, camera);
        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.guidesPending).toBe(true);
        upscaler.dispatchUpscale({ color }, camera);
        expect(upscaler.guidesPending).toBe(false);
    });

    it('dispose() during a split frame leaves no pending half-frame', async () => {
        const { upscaler } = await configured();
        const depth = new Texture(), velocity = new Texture();
        const camera = new PerspectiveCamera();

        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.guidesPending).toBe(true);

        upscaler.dispose();
        expect(upscaler.guidesPending).toBe(false);
        expect(upscaler.isReady).toBe(false);
    });
});
