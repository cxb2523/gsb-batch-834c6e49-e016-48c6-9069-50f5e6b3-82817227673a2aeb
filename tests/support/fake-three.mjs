// Minimal stand-in for the parts of `three` used by SplatGpuCache unit tests.
// Only the DataArrayTexture surface exercised by the cache is implemented.
// plain JS (no type annotations) so Node can load it without a TS transform.

export class DataArrayTexture {
    constructor(data, width, height, depth) {
        this.image = { data };
        this.width = width;
        this.height = height;
        this.depth = depth;
        this.format = null;
        this.type = null;
        this.internalFormat = null;
        this.generateMipmaps = false;
        this.minFilter = null;
        this.magFilter = null;
        this.flipY = false;
        this.onUpdate = null;
        this._needsUpdate = false;
        this.layersToUpdate = [];
        this.updateCount = 0;
    }

    addLayerUpdate(layer) {
        this.layersToUpdate.push(layer);
    }

    clearUpdateRanges() {
        this.layersToUpdate.length = 0;
    }

    /** 模拟GPU上传完成（默认 needsUpdate=true 时自动在微任务里触发） */
    flushUpdate() {
        const cb = this.onUpdate;
        this.layersToUpdate.length = 0;
        this._needsUpdate = false;
        this.updateCount++;
        DataArrayTexture.totalUpdates++;
        cb && cb();
    }

    get needsUpdate() {
        return this._needsUpdate;
    }

    set needsUpdate(v) {
        this._needsUpdate = v;
        if (v && DataArrayTexture.autoUpdate) {
            const self = this;
            queueMicrotask(() => {
                if (self._needsUpdate && self.onUpdate) self.flushUpdate();
            });
        }
    }

    dispose() {
        this.disposed = true;
    }
}
DataArrayTexture.autoUpdate = true;
/** 统计所有纹理实例的累计上传完成次数，用于验证写入没有被重复执行 */
DataArrayTexture.totalUpdates = 0;

export class Matrix4 {
    constructor() {
        this.elements = [];
    }
    fromArray(a) {
        this.elements = a;
        return this;
    }
    multiply() {
        return this;
    }
    clone() {
        return this;
    }
    multiplyMatrices() {
        return this;
    }
    invert() {
        return this;
    }
}
export class Vector3 {}
export class Vector2 {}
export class Vector4 {}
export class Plane {
    set() {
        return this;
    }
    normalize() {
        return this;
    }
    distanceToPoint() {
        return 0;
    }
}
export class Frustum {}
export const ShaderChunk = {};
export class BufferAttribute {}
export class BufferGeometry {}
export class InstancedBufferAttribute {}
export class InstancedBufferGeometry {}
export class Mesh {}
export class MeshBasicMaterial {}
export class Camera {}
export class WebGLRenderer {}
export class DataTexture {
    constructor(data, width = 1, height = 1) {
        this.image = { data, width, height };
        this.needsUpdate = false;
        this.onUpdate = null;
    }
    dispose() {
        this.disposed = true;
    }
}
export class ShaderMaterial {
    constructor(params = {}) {
        Object.assign(this, params);
        this.uniforms = params.uniforms || {};
        this.uniformsNeedUpdate = false;
        this.defines = params.defines || {};
    }
    dispose() {
        this.disposed = true;
    }
}
export class OrbitControls {}
export class DRACOLoader {}
export class GLTFLoader {}
export class PerspectiveCamera {}
export class OrthographicCamera {}
export class Renderer {}
export class Scene {}
export class Color {}
export class AmbientLight {}
export class DirectionalLight {}
export class Light {}
export class Object3D {}
export class Group {}
export class WebGLRenderTarget {}
export class Texture {}
export class CanvasTexture {}
export class DepthTexture {}
export class Float32BufferAttribute {}
export class Uint32BufferAttribute {}
export class Uint8BufferAttribute {}
export class Box3 {}
export class Sphere {}
export class Ray {}
export class Raycaster {}
export class Quaternion {}
export class Euler {}
export class Clock {}
export const LinearFilter = 1;
export const LinearMipmapLinearFilter = 1;
export const ClampToEdgeWrapping = 1;
export const RepeatWrapping = 1;
export const RGBAFormat = 1;
export const RGBFormat = 1;
export const RedFormat = 1;
export const FloatType = 1;
export const HalfFloatType = 1;
export const IntType = 1;
export const UnsignedShortType = 1;
export const NoBlending = 0;
export const AdditiveBlending = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const AlwaysDepth = 0;
export const LessEqualDepth = 1;
export const SRGBColorSpace = 'srgb';
export const LinearSRGBColorSpace = 'srgb-linear';
export const NoColorSpace = '';
export const NoToneMapping = 0;
export const PCFSoftShadowMap = 2;
export const DoubleSide = 2;
export const DynamicDrawUsage = 1;
export const NearestFilter = 1;
export const NormalBlending = 1;
export const RGBAIntegerFormat = 1;
export const UnsignedByteType = 1;
export const UnsignedIntType = 1;
