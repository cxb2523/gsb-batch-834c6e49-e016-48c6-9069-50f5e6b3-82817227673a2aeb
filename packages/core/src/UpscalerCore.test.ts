import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { GpuTimer } from './internal/GpuTimer';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

interface RecordedBindGroup {
    label: string;
    resources: unknown[];
}

function mockDevice() {
    const writes: Uint32Array[] = [];
    const bindGroups: RecordedBindGroup[] = [];
    const createdTextures: Array<{ label?: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const createdBuffers: Array<{ label?: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const resource = (descriptor: { size?: number; label?: string } = {}) => ({
        label: descriptor.label,
        width: 16,
        height: 16,
        sampleCount: 1,
        format: 'rgba16float',
        getBindGroupLayout: () => ({}),
        // Tagged so bind-group records show which texture a pass bound.
        createView: () => ({ viewOf: descriptor.label }),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4),
        unmap: () => {},
        destroy: vi.fn(),
    });
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: (descriptor: { size?: number; label?: string }) => {
            const buffer = resource(descriptor);
            createdBuffers.push(buffer);
            return buffer;
        },
        createTexture: vi.fn((descriptor: { label?: string }) => {
            const texture = resource(descriptor);
            createdTextures.push(texture);
            return texture;
        }),
        createBindGroup: (descriptor: { label: string; entries: Array<{ resource: unknown }> }) => {
            bindGroups.push({ label: descriptor.label, resources: descriptor.entries.map((entry) => entry.resource) });
            return resource(descriptor);
        },
        createCommandEncoder: vi.fn(() => encoder),
    };
    return {
        device, writes, bindGroups, createdTextures, createdBuffers, encoder,
        gpu: (label: string) => resource({ label }) as unknown as GPUTexture,
    };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];
// Every constants upload's frame index (ConstantsBuffer u32[21]).
const frameWrites = (writes: Uint32Array[]) => writes.map((data) => data[21]);

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates the published set through the allocator and returns its handles', async () => {
        const { device } = mockDevice();
        const allocated: CoreTextureDescriptor[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            allocated.push(descriptor);
            return { gpu: device.createTexture({}) as unknown as GPUTexture, handle: { name: descriptor.label }, destroy: vi.fn() };
        };
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, allocateTexture });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        expect(core.output).toEqual({ name: 'upscale-output' });
        expect(core.guides.dilatedMotion).toEqual({ name: 'upscale-dilated-motion' });
        expect(core.guides.history).toEqual({ name: 'upscale-history-0' });
        const byLabel = new Map(allocated.map((d) => [d.label, d]));
        expect(byLabel.get('upscale-output')).toMatchObject({ width: 64, height: 32, format: 'rgba16float' });
        expect(byLabel.get('upscale-dilated-depth-0')).toMatchObject({ width: 32, height: 16, format: 'r32float' });
        expect(byLabel.get('upscale-masks')).toMatchObject({ format: 'rgba8unorm' });
    });

    it('defaults to raw GPUTexture handles', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.output).toMatchObject({ label: 'upscale-output' });
    });

    it('stages camera facts from plain frame data', async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET))
            .toBe(FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET);

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET)).toBe(0);
    });

    it("reads the projection type from a denoiser-style camera's matrix", async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        const perspective = new Float32Array(16);
        perspective[11] = -1; // w = −z
        const orthographic = new Float32Array(16);
        orthographic[15] = 1;

        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: perspective });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: orthographic });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(0);
        expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100 })).toThrow(/perspective/);
    });

    it('encodes into a host encoder without submitting', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
    });

    it('advances jitter only on the temporal path with jitter on', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        expect(core.beginFrame()).toBe(core.jitter);
        expect(core.jitterPhase).toBe(1);
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.beginFrame()).toBeNull();
    });
});

//* Split-frame dispatch — dispatchGuides() + dispatchUpscale() must advance
//* the shared frame state (frame index, history/exposure ping-pong, scatter
//* flip, shading-memory staleness) exactly like the monolithic dispatch().

describe('UpscalerCore split-frame dispatch', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const CAMERA = { near: 0.1, far: 100, perspective: true };

    // A core whose published textures are named handles, so the ping-ponged
    // products are observable through the guides bundle.
    function splitFixture() {
        const mock = mockDevice();
        const allocatorGpu = new Set<unknown>();
        const destroyedHandles: string[] = [];
        const allocatedLabels: string[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            const gpu = mock.device.createTexture({ label: descriptor.label }) as unknown as GPUTexture;
            allocatorGpu.add(gpu);
            allocatedLabels.push(descriptor.label!);
            return {
                gpu,
                handle: { name: descriptor.label! },
                destroy: vi.fn(() => { destroyedHandles.push(descriptor.label!); }),
            };
        };
        const core = new UpscalerCore<{ name: string }>({
            device: mock.device as unknown as GPUDevice,
            allocateTexture,
        });
        // Raw textures/buffers the core owns directly (not allocator-backed).
        const ownedTextures = () => mock.createdTextures.filter((t) => !allocatorGpu.has(t));
        const ownedBuffers = () => mock.createdBuffers.filter((b) => b.label !== 'upscale-constants');
        return { core, mock, allocatorGpu, destroyedHandles, allocatedLabels, ownedTextures, ownedBuffers };
    }

    const guidesSnapshot = (core: UpscalerCore<{ name: string }>) => ({
        history: (core.guides.history as { name: string }).name,
        exposure: (core.guides.exposure as { name: string }).name,
        locks: (core.guides.lockStatus as { name: string }).name,
        depth: (core.guides.dilatedDepth as { name: string }).name,
        previousDepth: (core.guides.previousDepth as { name: string }).name,
    });

    // The reconstructed-depth buffer each frame's reconstruct pass scattered
    // into — the scatter ping-pong, observable at the bind groups.
    const scatterWrites = (bindGroups: RecordedBindGroup[]) =>
        bindGroups
            .filter((group) => group.label === 'upscale-reconstruct')
            .map((group) => (group.resources[5] as { buffer: { label: string } }).buffer.label);

    const temporalInputs = (gpu: (label: string) => GPUTexture) => ({
        color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity'),
    });

    it('advances state exactly like the monolithic dispatch', async () => {
        const mono = splitFixture();
        const split = splitFixture();
        mono.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        split.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await mono.core.prepare();
        await split.core.prepare();

        for (let frame = 0; frame < 3; frame++) {
            mono.core.dispatch(temporalInputs(mono.mock.gpu), CAMERA);

            split.core.dispatchGuides(
                { depth: split.mock.gpu('depth'), velocity: split.mock.gpu('velocity') },
                CAMERA,
            );
            expect(split.core.guidesPending).toBe(true);
            split.core.dispatchUpscale({ color: split.mock.gpu('color') }, CAMERA);
            expect(split.core.guidesPending).toBe(false);

            // History, exposure, locks and depth ping-pong identically.
            expect(guidesSnapshot(split.core)).toEqual(guidesSnapshot(mono.core));
            // The scatter buffers flipped the same number of times.
            expect(scatterWrites(split.mock.bindGroups)).toEqual(scatterWrites(mono.mock.bindGroups));
            // Shading-memory zeroing (writeTexture) happened on the same frames.
            expect(split.mock.device.queue.writeTexture.mock.calls.length)
                .toBe(mono.mock.device.queue.writeTexture.mock.calls.length);
        }

        // Frame indices: the split frame uploads constants twice per frame
        // (once per stage) with the monolithic frame's index both times.
        expect(frameWrites(mono.mock.writes)).toEqual([0, 1, 2]);
        expect(frameWrites(split.mock.writes)).toEqual([0, 0, 1, 1, 2, 2]);
        // RESET only on the first frame, on both paths.
        expect(mono.mock.writes.map((w) => w[20] & FLAG_RESET)).toEqual([FLAG_RESET, 0, 0]);
        expect(split.mock.writes.map((w) => w[20] & FLAG_RESET))
            .toEqual([FLAG_RESET, FLAG_RESET, 0, 0, 0, 0]);
    });

    it('rejects a second early stage and a monolithic dispatch mid-split, then recovers', async () => {
        const { core, mock } = splitFixture();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        // The late stage without an early stage is an error too.
        expect(() => core.dispatchUpscale({ color: mock.gpu('color') }, CAMERA))
            .toThrow(/dispatchGuides/);

        core.dispatchGuides({ depth: mock.gpu('depth'), velocity: mock.gpu('velocity') }, CAMERA);
        expect(core.guidesPending).toBe(true);

        // None of these may smuggle the half-frame into a new frame.
        expect(() => core.dispatchGuides({ depth: mock.gpu('depth'), velocity: mock.gpu('velocity') }, CAMERA))
            .toThrow(/dispatchUpscale/);
        expect(() => core.dispatch(temporalInputs(mock.gpu), CAMERA)).toThrow(/split frame/);
        expect(() => core.encode(
            mock.encoder as unknown as GPUCommandEncoder, temporalInputs(mock.gpu), CAMERA,
        )).toThrow(/split frame/);
        expect(() => core.encodeGuides(
            mock.encoder as unknown as GPUCommandEncoder,
            { depth: mock.gpu('depth'), velocity: mock.gpu('velocity') },
            CAMERA,
        )).toThrow(/dispatchUpscale/);
        expect(core.guidesPending).toBe(true);

        // Recovery: finishing the split frame advances the frame exactly once.
        core.dispatchUpscale({ color: mock.gpu('color') }, CAMERA);
        expect(core.guidesPending).toBe(false);
        expect(frameWrites(mock.writes)).toEqual([0, 0]);

        // The next frame — split or monolithic — proceeds normally.
        core.dispatch(temporalInputs(mock.gpu), CAMERA);
        expect(frameWrites(mock.writes)).toEqual([0, 0, 1]);
        expect(guidesSnapshot(core).history).toBe('upscale-history-0');
    });

    it('mixes split and monolithic frames with identical ping-pong progression', async () => {
        const reference = splitFixture();
        const mixed = splitFixture();
        reference.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        mixed.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await reference.core.prepare();
        await mixed.core.prepare();

        // Reference: four monolithic frames. Mixed: split, mono, split, mono.
        for (let frame = 0; frame < 4; frame++) {
            reference.core.dispatch(temporalInputs(reference.mock.gpu), CAMERA);
            if (frame % 2 === 0) {
                mixed.core.dispatchGuides(
                    { depth: mixed.mock.gpu('depth'), velocity: mixed.mock.gpu('velocity') },
                    CAMERA,
                );
                mixed.core.dispatchUpscale({ color: mixed.mock.gpu('color') }, CAMERA);
            } else {
                mixed.core.dispatch(temporalInputs(mixed.mock.gpu), CAMERA);
            }
            expect(guidesSnapshot(mixed.core)).toEqual(guidesSnapshot(reference.core));
        }
        expect(scatterWrites(mixed.mock.bindGroups)).toEqual(scatterWrites(reference.mock.bindGroups));
        expect(frameWrites(reference.mock.writes)).toEqual([0, 1, 2, 3]);
        expect(frameWrites(mixed.mock.writes)).toEqual([0, 0, 1, 2, 2, 3]);
    });

    it('configure() during a split frame resets the half-frame and releases the old set', async () => {
        const f = splitFixture();
        f.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await f.core.prepare();
        f.core.dispatchGuides(
            { depth: f.mock.gpu('depth'), velocity: f.mock.gpu('velocity') },
            CAMERA,
        );
        expect(f.core.guidesPending).toBe(true);

        const texturesBefore = f.ownedTextures();
        const buffersBefore = f.ownedBuffers();
        const handlesBefore = [...f.allocatedLabels];

        f.core.configure({ displayWidth: 128, displayHeight: 64, customUpscaleRatio: 2 });

        // The half-frame is gone, not carried into the new configuration.
        expect(f.core.guidesPending).toBe(false);
        for (const texture of texturesBefore) expect(texture.destroy).toHaveBeenCalled();
        for (const buffer of buffersBefore) expect(buffer.destroy).toHaveBeenCalled();
        for (const label of handlesBefore) expect(f.destroyedHandles).toContain(label);

        // Both frame shapes work immediately after, as a fresh first frame.
        f.core.dispatch(temporalInputs(f.mock.gpu), CAMERA);
        expect(lastFlags(f.mock.writes) & FLAG_RESET).toBe(FLAG_RESET);
        f.core.dispatchGuides({ depth: f.mock.gpu('depth'), velocity: f.mock.gpu('velocity') }, CAMERA);
        expect(f.core.guidesPending).toBe(true);
        f.core.dispatchUpscale({ color: f.mock.gpu('color') }, CAMERA);
        expect(f.core.guidesPending).toBe(false);
        expect(frameWrites(f.mock.writes)).toEqual([0, 0, 1, 1]);
    });

    it('dispose() during a split frame releases every texture and buffer', async () => {
        const f = splitFixture();
        f.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await f.core.prepare();
        f.core.dispatchGuides(
            { depth: f.mock.gpu('depth'), velocity: f.mock.gpu('velocity') },
            CAMERA,
        );
        expect(f.core.guidesPending).toBe(true);

        const textures = f.ownedTextures();
        const buffers = f.ownedBuffers();
        const handles = [...f.allocatedLabels];
        expect(textures.length).toBeGreaterThan(0);
        expect(buffers.length).toBeGreaterThan(0);

        f.core.dispose();

        expect(f.core.guidesPending).toBe(false);
        for (const texture of textures) expect(texture.destroy).toHaveBeenCalled();
        for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalled();
        for (const label of handles) expect(f.destroyedHandles).toContain(label);
        // The constants buffer is the core's too.
        const constants = f.mock.createdBuffers.find((b) => b.label === 'upscale-constants');
        expect(constants?.destroy).toHaveBeenCalled();

        // No dangling half-frame: a fresh configure starts clean.
        f.core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await f.core.prepare();
        expect(f.core.guidesPending).toBe(false);
        f.core.dispatch(temporalInputs(f.mock.gpu), CAMERA);
        expect(f.core.guidesPending).toBe(false);
    });

    it('counts a split frame as one frame for GPU timing', async () => {
        const beginFrame = vi.spyOn(GpuTimer.prototype, 'beginFrame').mockImplementation(() => {});
        const readback = vi.spyOn(GpuTimer.prototype, 'readback').mockImplementation(() => {});
        vi.spyOn(GpuTimer.prototype, 'resolve').mockImplementation(() => {});
        vi.spyOn(GpuTimer.prototype, 'passDescriptor').mockReturnValue(undefined);

        const { device, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, gpuTiming: true });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        core.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, CAMERA);
        core.dispatchUpscale({ color: gpu('color') }, CAMERA);
        // Both stages timed the SAME frame index; the early submit does not
        // complete the frame, the late one does.
        expect(beginFrame.mock.calls).toEqual([[0], [0]]);
        expect(readback.mock.calls).toEqual([[false], []]);

        core.dispatch(temporalInputs(gpu), CAMERA);
        expect(beginFrame.mock.calls).toEqual([[0], [0], [1]]);
        expect(readback.mock.calls).toEqual([[false], [], []]);

        // The guides-only path completes its frame in the early stage.
        const guidesOnly = new UpscalerCore({ device: device as unknown as GPUDevice, gpuTiming: true });
        guidesOnly.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, path: 'guides' });
        await guidesOnly.prepare();
        beginFrame.mockClear();
        readback.mockClear();
        guidesOnly.dispatchGuides({ depth: gpu('depth'), velocity: gpu('velocity') }, CAMERA);
        expect(beginFrame.mock.calls).toEqual([[0]]);
        expect(readback.mock.calls).toEqual([[true]]);
    });
});
