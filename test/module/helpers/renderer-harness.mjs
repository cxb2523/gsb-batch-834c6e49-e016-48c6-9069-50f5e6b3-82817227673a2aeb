// Builds a fake app/device/camera world and drives StochasticSplatRenderer frames through the
// same EngineResidentSetProvider.onFrame path the engine uses, without a WebGPU device. The
// gpu objects come from the mocked playcanvas (mock-playcanvas.mjs), so allocations and
// destroys are observable.
import { EventRegistry, Frustum, GraphNode, Mat4, markExternal, mockPlaycanvas, Vec3 } from './mock-playcanvas.mjs';

// one resident splat node's worth of a resident set: enough for the renderer's chunk table,
// frustum cull and projection dispatch (the dispatches themselves are recorded, not executed)
export const makeResidentSet = (version = 1, count = 1024) => {
    const modelMatrix = new Mat4().setIdentity();
    const node = {
        fileIndex: 0,
        nodeIndex: 0,
        lodIndex: 0,
        sourceBase: 0,
        count,
        slotBase: 0,
        allocId: 1
    };
    const resource = {
        numSplats: count,
        antiAlias: false
    };
    return {
        version,
        activeSplats: count,
        slotCapacity: count,
        fullRebuild: false,
        changedAllocIds: new Set(),
        files: [{ fileIndex: 0, lodIndex: 0, nodes: [node], modelMatrix, resource }],
        nodes: [node],
        nodeSpheres: new Float32Array([0, 0, 0, 1000])
    };
};

// the work buffer the WorkBufferSplatSource reads: one declared stream and a texture for it
export const makeManager = () => {
    const texture = markExternal(new mockPlaycanvas.Texture(null, { name: 'work', width: 64, height: 64 }));
    const format = {
        streams: [{ name: 'workStream', format: 0 }],
        getComputeInputDeclarations: () => '',
        getReadCode: () => '',
        getComputeBindFormats: () => []
    };
    const workBuffer = {
        device: null,
        format,
        textureSize: 64,
        getTexture: () => texture,
        render: () => {},
        renderColor: () => {},
        resize: () => {},
        orderBuffer: markExternal(new mockPlaycanvas.StorageBuffer(null, 16))
    };
    return {
        world: {
            currentState: undefined,
            workBuffer,
            invalidate: () => {}
        },
        renderer: { prepareRenderView: () => true }
    };
};

// the device the renderer drives: indirect draw slots, recorded dispatches, a backbuffer
export const makeDevice = (width = 128, height = 96) => {
    const drawSlots = [];
    const dispatchSlots = [];
    const device = {
        isWebGPU: true,
        width,
        height,
        wgpu: undefined,
        xrCurrentViewIndex: -1,
        xrSubImages: undefined,
        backBuffer: { flipY: true },
        indirectDrawBuffer: markExternal(new mockPlaycanvas.StorageBuffer(null, 1024)),
        indirectDispatchBuffer: markExternal(new mockPlaycanvas.StorageBuffer(null, 1024)),
        getIndirectDrawSlot(count = 1) {
            const slot = drawSlots.length;
            for (let i = 0; i < count; i++) drawSlots.push(slot + i);
            return slot;
        },
        getIndirectDispatchSlot(count = 1) {
            const slot = dispatchSlots.length;
            for (let i = 0; i < count; i++) dispatchSlots.push(slot + i);
            return slot;
        },
        dispatches: [],
        computeDispatch(computes, name) {
            for (const compute of computes) this.dispatches.push({ compute, name });
        }
    };
    return device;
};

// a camera component with the Camera the renderer reads and an entity node
export const makeCamera = () => {
    const entity = new GraphNode('camera');
    entity.getPosition = () => new Vec3(0, 0, 0);
    const camera = new mockPlaycanvas.Camera();
    camera.node = entity;
    // a simple perspective projection with nonzero focal terms, and a matching view matrix
    camera.projectionMatrix.setPerspective(60, 4 / 3, 0.1, 1000);
    camera.projection = mockPlaycanvas.PROJECTION_PERSPECTIVE;
    camera.viewMatrix.setIdentity();
    camera.nearClip = 0.1;
    camera.farClip = 1000;
    camera.renderTarget = null;
    return { camera, entity };
};

export const makeApp = (device, cameraComponent, layer) => {
    const events = new EventRegistry();
    const app = {
        graphicsDevice: device,
        renderer: {
            renderForwardLayer() {}
        },
        scene: {
            gsplat: {
                alphaClipForward: 0.01,
                minContribution: 0,
                antiAliasFilterSize: 1,
                minPixelSize: 0
            },
            layers: {
                getLayerByName: (name) => (name === layer.name ? layer : null)
            }
        },
        systems: {
            gsplat: events
        },
        on: events.on.bind(events),
        off: events.off.bind(events),
        fire: events.fire.bind(events),
        renderNextFrame: false,
        stats: { vram: 0 }
    };
    return { app, events };
};

// the full world: the renderer under test, plus the handles a test drives. The frame callback
// is captured from the provider's frame:ready registration the renderer makes in its
// constructor, so tests call fireFrame() exactly as the engine's gsplat update would.
export const makeWorld = async (options = {}) => {
    const device = makeDevice(options.width ?? 128, options.height ?? 96);
    const { camera, entity } = makeCamera();
    const layer = new mockPlaycanvas.Layer('World');
    const { app, events } = makeApp(device, camera, layer);
    const cameraComponent = { camera, entity, renderTarget: null };
    // captureCameraSnapshot reads the Camera both through entity.camera.camera and directly off
    // the component (cam.viewMatrix / cam.projectionMatrix), so mirror the matrices on it
    cameraComponent.viewMatrix = camera.viewMatrix;
    cameraComponent.projectionMatrix = camera.projectionMatrix;
    cameraComponent.nearClip = camera.nearClip;
    cameraComponent.farClip = camera.farClip;
    cameraComponent.projection = camera.projection;
    // captureCameraSnapshot reads the Camera through entity.camera.camera
    entity.camera = cameraComponent;

    const { StochasticSplatRenderer } = await import('../../../src/render/stochastic-splat-renderer.ts');

    const renderer = new StochasticSplatRenderer(app, cameraComponent, layer, {
        source: 'workbuffer',
        mode: 'pixel',
        variant: options.variant ?? '',
        requestFrame: options.requestFrame ?? (() => {})
    });

    // The renderer subscribes through EngineResidentSetProvider.onFrame; reach that callback
    // directly instead of building the engine world state the provider flattens, so the test
    // supplies a hand-made resident set. The provider keeps one frame:ready listener on the
    // gsplat system, which proves the subscription was made.
    const frameListeners = events.handlers.get('frame:ready');
    if (!frameListeners || frameListeners.size !== 1) {
        throw new Error('expected exactly one frame:ready listener');
    }

    let resident = makeResidentSet(1, options.splats ?? 1024);
    const manager = makeManager();

    // records every view whose identity check fired invalidateFrame() during a frame, with the
    // state the view held just before it was dropped: the proof that a changed frame cannot read
    // the previous target's history, depth grid or projected cache
    const invalidations = [];
    const instrument = (view) => {
        if (view.__instrumented) return;
        view.__instrumented = true;
        const original = view.invalidateFrame.bind(view);
        view.invalidateFrame = () => {
            invalidations.push({
                view,
                hadHistory: view.taaHistoryValid,
                hadPrevFrame: view.prevValid,
                oldIdentity: view.frameIdentity ? { ...view.frameIdentity } : null,
                oldCache: view.cacheBuffer
            });
            original();
        };
    };
    renderer.views.forEach(instrument);

    // invoke the renderer's frame hook with the same arguments the provider gives it
    const fireFrame = (overrides = {}) => {
        const rt = overrides.renderTarget ?? null;
        cameraComponent.renderTarget = rt;
        camera.renderTarget = rt;
        if (overrides.width !== undefined) {
            device.width = overrides.width;
        }
        if (overrides.height !== undefined) {
            device.height = overrides.height;
        }
        if (overrides.orthographic) {
            camera.projection = mockPlaycanvas.PROJECTION_ORTHOGRAPHIC;
        } else if (overrides.perspective) {
            camera.projection = mockPlaycanvas.PROJECTION_PERSPECTIVE;
        }
        if (overrides.xrViews) {
            camera.xrActive = true;
            camera.xrViews = overrides.xrViews;
        } else if (overrides.xr === false) {
            camera.xrActive = false;
            camera.xrViews = null;
        }
        device.xrCurrentViewIndex = overrides.viewIndex ?? -1;
        if (overrides.set) resident = overrides.set;
        device.dispatches.length = 0;
        invalidations.length = 0;
        renderer.views.forEach(instrument);
        renderer.frame(resident, overrides.changed ?? false, manager);
        // frameend flushes the rate-map measurement state and internal frame requests
        events.fire('frameend');
        return renderer;
    };

    return {
        renderer,
        app,
        device,
        camera,
        cameraComponent,
        layer,
        events,
        manager,
        fireFrame,
        invalidations,
        // the history-valid bit (taaParams.y) the TAA shader receives for a view, after applying
        // the frame's deferred bindings: 0 makes the pass ignore any previous history entirely
        historyBit: (index = 0) => {
            const view = renderer.views[index];
            for (const apply of view.bindings) apply();
            const material = renderer.taaMaterial;
            return material.params.taaParams?.[1];
        },
        set: () => resident,
        makeResidentSet,
        Frustum
    };
};

// two eye matrix pairs like the engine's XR views: parallel view axes, own translations
export const makeEyes = () => {
    const leftView = new Mat4().setIdentity();
    const rightView = new Mat4().setIdentity();
    rightView.data[12] = 0.063;
    const projection = new Mat4().setPerspective(60, 1, 0.1, 1000);
    return [
        { viewOffMat: leftView, projMat: projection.clone() },
        { viewOffMat: rightView, projMat: projection.clone() }
    ];
};
