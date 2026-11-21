// Headless harness for the stochastic splat renderer. A WebGPU device cannot exist in node, so
// module hooks replace `playcanvas` with a mock that keeps the engine's real math classes
// (Mat4, Vec3, Frustum, ...) and fakes the GPU objects (textures, buffers, render targets,
// computes, passes) just far enough to run the renderer's per-frame state machine and to record
// every allocation and destroy(), which is what the cross-frame lifecycle tests assert on.
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { BoundingBox, BoundingSphere, Color, Frustum, GraphNode, Mat3, Mat4, Quat, Vec2, Vec3, Vec4 } from 'playcanvas';

export const destroyed = new Set();
export const live = new Set();

const track = (object) => {
    live.add(object);
    return object;
};

// gpu objects the test harness itself made (the fake work buffer), which the renderer does not
// own and must not be expected to destroy
export const externalObjects = new Set();

export const markExternal = (object) => {
    externalObjects.add(object);
    live.delete(object);
    return object;
};

// a gpu object the renderer can size, write and destroy; every instance is recorded so a test
// can prove a removed view or an invalidated frame leaves nothing behind
class GpuObject {
    constructor(name = '') {
        this.name = name;
        this.destroyed = false;
        track(this);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        destroyed.add(this);
        live.delete(this);
    }
}

class StorageBuffer extends GpuObject {
    constructor(device, byteSize, usage = 0) {
        super('buffer');
        this.device = device;
        this.byteSize = byteSize;
        this.usage = usage;
    }

    clear() {}

    write() {}

    async read() {
        return Promise.resolve();
    }
}

class Texture extends GpuObject {
    constructor(device, options = {}) {
        super(options.name ?? 'texture');
        this.device = device;
        this.width = options.width ?? 4;
        this.height = options.height ?? 4;
        this.format = options.format ?? 0;
        this.mipmaps = options.mipmaps ?? false;
        this.minFilter = options.minFilter;
        this.magFilter = options.magFilter;
        this.addressU = options.addressU;
        this.addressV = options.addressV;
        this.gpuSize = this.width * this.height * 8;
    }

    resize(width, height) {
        if (this.destroyed) throw new Error(`resize of destroyed texture ${this.name}`);
        this.width = width;
        this.height = height;
        this.gpuSize = width * height * 8;
    }
}

class RenderTarget extends GpuObject {
    constructor(options = {}) {
        super(options.name ?? 'target');
        this.options = options;
        const color = options.colorBuffer ?? options.colorBuffers?.[0];
        this.colorBuffer = color ?? null;
        this.colorBuffers = options.colorBuffers ?? (color ? [color] : []);
        this.depthBuffer = options.depthBuffer ?? null;
        this.samples = options.samples ?? 1;
        this.flipY = options.flipY ?? true;
        this.width = this.colorBuffer?.width ?? options.width ?? 4;
        this.height = this.colorBuffer?.height ?? options.height ?? 4;
    }

    resize(width, height) {
        if (this.destroyed) throw new Error(`resize of destroyed target ${this.name}`);
        this.width = width;
        this.height = height;
        for (const texture of this.colorBuffers) texture.resize(width, height);
        if (this.depthBuffer) this.depthBuffer.resize(width, height);
    }
}

class Shader extends GpuObject {
    constructor(device, options = {}) {
        super(options.name ?? 'shader');
        this.options = options;
    }
}

class Compute extends GpuObject {
    constructor(device, shader, name = 'compute') {
        super(name);
        this.shader = shader;
        this.params = {};
    }

    static calcDispatchSize(count, out) {
        out.x = Math.max(1, count);
        out.y = 1;
        return out;
    }

    setParameter(name, value) {
        this.params[name] = value;
    }

    setupDispatch() {}

    setupIndirectDispatch() {}
}

class BindGroupFormat extends GpuObject {
    constructor(device, formats = []) {
        super('bind-group-format');
        this.formats = formats;
    }
}

class BindStorageBufferFormat {
    constructor(name, stage, write = false) {
        this.name = name;
        this.stage = stage;
        this.write = write;
    }
}

class BindTextureFormat {
    constructor(name, stage, dimension, type, depth) {
        this.name = name;
        this.stage = stage;
        this.dimension = dimension;
        this.type = type;
        this.depth = depth;
    }
}

class BindStorageTextureFormat {
    constructor(name, stage, format, access) {
        this.name = name;
        this.stage = stage;
        this.format = format;
        this.access = access;
    }
}

class UniformBufferFormat {
    constructor(device, formats = []) {
        this.formats = formats;
    }
}

class UniformFormat {
    constructor(name, type) {
        this.name = name;
        this.type = type;
    }
}

class ShaderMaterial extends GpuObject {
    constructor(options = {}) {
        super(options.uniqueName ?? 'material');
        this.options = options;
        this.defines = new Map();
        this.params = {};
        this.blendType = 0;
        this.depthWrite = false;
        this.depthTest = false;
        this.depthFunc = 0;
        this.cull = 0;
        this.fragmentOutputTypes = options.fragmentOutputTypes;
    }

    setDefine(name, value) {
        if (value === undefined) this.defines.delete(name);
        else this.defines.set(name, value);
    }

    setParameter(name, value) {
        this.params[name] = value;
    }

    getParameter(name) {
        return this.params[name];
    }

    update() {}
}

class Mesh extends GpuObject {
    constructor(device) {
        super('mesh');
        this.device = device;
    }

    setPositions() {
        return this;
    }

    setIndices() {
        return this;
    }

    update() {}
}

class MeshInstance extends GpuObject {
    constructor(mesh, material, node) {
        super('mesh-instance');
        this.mesh = mesh;
        this.material = material;
        this.node = node;
        this.cull = true;
        this.castShadow = true;
        this.receiveShadow = true;
        this.visible = true;
        this.pick = true;
        this.drawOrder = 0;
        this.params = {};
    }

    setParameter(name, value) {
        this.params[name] = value;
    }

    setIndirect() {}

    destroy() {
        super.destroy();
    }
}

class RenderPass extends GpuObject {
    constructor(device) {
        super('render-pass');
        this.device = device;
        this.renderTarget = null;
        this.enabled = true;
        this.instances = [];
        this.name = '';
    }

    init(target) {
        this.renderTarget = target;
    }

    setClearColor() {}

    setClearDepth() {}

    execute() {}
}

class FramePass extends GpuObject {
    constructor(device) {
        super('frame-pass');
        this.device = device;
        this.enabled = true;
        this.name = '';
    }

    execute() {}
}

// a camera the renderer reads matrices and clips from; matrices default to an identity view and
// a simple perspective projection
class Camera {
    constructor() {
        this.node = null;
        this.viewMatrix = new Mat4().setIdentity();
        this.projectionMatrix = new Mat4().setIdentity();
        this.projection = 0;
        this.nearClip = 0.1;
        this.farClip = 1000;
        this.beforePasses = [];
        this.xrActive = false;
        this.xrViews = null;
        this.flipY = true;
    }

    updateViewTransforms() {}

    static applyShaderProjectionTransform(projection, out) {
        return out.copy(projection);
    }
}

void Frustum;

class Layer {
    constructor(name = 'layer') {
        this.name = name;
        this.instances = [];
    }

    addMeshInstances(list) {
        for (const instance of list) if (!this.instances.includes(instance)) this.instances.push(instance);
    }

    removeMeshInstances(list) {
        this.instances = this.instances.filter((instance) => !list.includes(instance));
    }
}

class EventRegistry {
    constructor() {
        this.handlers = new Map();
    }

    on(name, fn) {
        if (!this.handlers.has(name)) this.handlers.set(name, new Set());
        this.handlers.get(name).add(fn);
        return { name, fn, off: () => this.off(name, fn) };
    }

    once(name, fn) {
        const wrap = (...args) => {
            this.off(name, wrap);
            fn(...args);
        };
        return this.on(name, wrap);
    }

    off(name, fn) {
        this.handlers.get(name)?.delete(fn);
    }

    fire(name, ...args) {
        for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...args);
    }
}

// every numeric constant the renderer imports only needs a stable, distinct value here: the
// shaders never compile in node, so an engine constant's actual number does not matter

const mockPlaycanvas = {
    // real math: the renderer's matrix bookkeeping is real code worth exercising
    BoundingBox,
    BoundingSphere,
    Color,
    Frustum,
    GraphNode,
    Mat3,
    Mat4,
    Quat,
    Vec2,
    Vec3,
    Vec4,
    // gpu and frame-graph fakes
    BindGroupFormat,
    BindStorageBufferFormat,
    BindStorageTextureFormat,
    BindTextureFormat,
    BindUniformBufferFormat: class {
        constructor(name, stage) {
            this.name = name;
            this.stage = stage;
        }
    },
    BLEND_NONE: 0,
    BLEND_PREMULTIPLIED: 1,
    BUFFERUSAGE_COPY_DST: 1,
    BUFFERUSAGE_COPY_SRC: 2,
    Compute,
    CULLFACE_NONE: 0,
    FILTER_LINEAR: 1,
    FILTER_NEAREST: 0,
    FramePass,
    FUNC_ALWAYS: 1,
    FUNC_LESS: 2,
    Mesh,
    MeshInstance,
    RenderPass,
    RenderTarget,
    SAMPLETYPE_DEPTH: 1,
    SAMPLETYPE_FLOAT: 0,
    SAMPLETYPE_UINT: 1,
    SAMPLETYPE_UNFILTERABLE_FLOAT: 2,
    SEMANTIC_POSITION: 'POSITION',
    Shader,
    SHADER_FORWARD: 0,
    SHADERLANGUAGE_WGSL: 0,
    SHADERSTAGE_COMPUTE: 1,
    ShaderMaterial,
    StorageBuffer,
    TEXTUREDIMENSION_2D: 0,
    Texture,
    UniformBufferFormat,
    UniformFormat,
    UNIFORMTYPE_FLOAT: 0,
    UNIFORMTYPE_MAT4: 1,
    UNIFORMTYPE_UINT: 2,
    UNIFORMTYPE_VEC2: 3,
    UNIFORMTYPE_VEC4: 4,
    Camera,
    Layer,
    PIXELFORMAT_DEPTH: 1,
    PIXELFORMAT_R32U: 2,
    PIXELFORMAT_R8U: 3,
    PIXELFORMAT_RGBA8: 4,
    PIXELFORMAT_RGBA16F: 5,
    PIXELFORMAT_RGBA16U: 6,
    PIXELFORMAT_RGBA32F: 7,
    PIXELFORMAT_RGBA32U: 8,
    ADDRESS_CLAMP_TO_EDGE: 0,
    PRIMITIVE_TRIANGLES: 0,
    PROJECTION_PERSPECTIVE: 0,
    PROJECTION_ORTHOGRAPHIC: 1,
    BLENDEQUATION_MIN: 0,
    BLENDMODE_ONE: 1,
    RenderPassPicker: class extends RenderPass {},
    ShaderChunks: {},
    BlendState: class {}
};

const mockUrl = pathToFileURL('__mock_playcanvas__').href;

// the renderer's sources are TypeScript with parameter properties, which node's built-in
// type stripping does not cover; transpile them with the project's own typescript instead and
// redirect `playcanvas` at the mock
export const installHooks = () => {
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'playcanvas') {
                return { url: mockUrl, shortCircuit: true };
            }
            // the sources import one another without extensions; try the .ts file first
            if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
                const candidate = new URL(`${specifier}.ts`, context.parentURL);
                if (existsSync(fileURLToPath(candidate))) {
                    return { url: candidate.href, shortCircuit: true };
                }
            }
            return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
            if (url === mockUrl) {
                return {
                    format: 'module',
                    shortCircuit: true,
                    source: Object.keys(mockPlaycanvas)
                        .map((key) => `export const ${key} = globalThis.__mockPlaycanvas.${key};`)
                        .join('\n')
                };
            }
            if (url.startsWith('file:') && url.endsWith('.ts')) {
                const fileName = fileURLToPath(url);
                const sourceText = readFileSync(fileName, 'utf8');
                const { outputText } = ts.transpileModule(sourceText, {
                    compilerOptions: {
                        module: ts.ModuleKind.ESNext,
                        target: ts.ScriptTarget.ES2022,
                        sourceMap: false,
                        inlineSourceMap: false
                    },
                    fileName
                });
                return { format: 'module', shortCircuit: true, source: outputText };
            }
            return nextLoad(url, context);
        }
    });
    globalThis.__mockPlaycanvas = mockPlaycanvas;
};

export {
    Camera,
    Color,
    EventRegistry,
    Frustum,
    GpuObject,
    GraphNode,
    Layer,
    Mat4,
    RenderTarget,
    StorageBuffer,
    Texture,
    Vec3,
    mockPlaycanvas
};
