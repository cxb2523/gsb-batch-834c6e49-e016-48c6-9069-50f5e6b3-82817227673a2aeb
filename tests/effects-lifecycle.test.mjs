import test from 'node:test';
import assert from 'node:assert/strict';

// 最小化 DOM/Canvas 桩：effects.js 只用到 canvas 2d 渐变与少量元素方法，
// 无需浏览器或 WebGL 即可在 Node 下验证图层重建与资源释放生命周期。
function installDomStubs() {
  const gradient = {addColorStop() {}};
  const ctx2d = {
    createRadialGradient() { return gradient; },
    fillRect() {},
    fillStyle: ''
  };
  globalThis.matchMedia ??= () => ({matches: false});
  globalThis.document ??= {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ctx2d
        };
      }
      return {
        className: '',
        innerHTML: '',
        style: {},
        dataset: {},
        hidden: false,
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
      };
    }
  };
}

installDomStubs();

const THREE = await import('../src/vendor/three.module.js');
const {createEffects, associations} = await import('../src/scene/effects.js');

const BILATERAL_CODE = 'LI4'; // 合谷：双侧穴，且含 3 个主治靶区
const MIDLINE_CODE = 'CV12';  // 中脘：正中单穴关联

function createLayer() {
  const scene = new THREE.Group();
  const container = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this; },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx >= 0) this.children.splice(idx, 1);
      node.parentNode = null;
      return node;
    }
  };
  return {scene, container, layer: createEffects(scene, container)};
}

function startPoint(side) {
  return new THREE.Vector3(1.76 * side, 4.3, 0.12);
}

function collectMaterials(group) {
  const materials = [];
  group.traverse(obj => {
    if (obj.material) {
      Array.isArray(obj.material) ? materials.push(...obj.material) : materials.push(obj.material);
    }
  });
  return materials;
}

test('effect layer rebuilds mirrored arcs per observation side and drops the old side', () => {
  assert.ok(associations[BILATERAL_CODE]);
  const {scene, container, layer} = createLayer();
  const info = associations[BILATERAL_CODE];

  layer.show({code: BILATERAL_CODE}, startPoint(1), 1);
  assert.equal(layer.active, true);
  assert.equal(layer.side, 1);
  assert.equal(container.children.length, info.targets.length);

  // 所有弧线起点与靶区 x 坐标必须与当前侧同号（正中靶区 x=0 除外），不得残留对侧数据。
  for (const arc of layer.snapshot) {
    assert.equal(arc.side, 1);
    assert.ok(arc.start[0] > 0, 'arc start must be on the left (+X) side');
    assert.ok(arc.end[0] >= 0, 'mirrored target must not cross to the opposite side');
  }

  layer.show({code: BILATERAL_CODE}, startPoint(-1), -1);
  assert.equal(layer.side, -1);
  assert.equal(layer.snapshot.length, info.targets.length);
  for (const arc of layer.snapshot) {
    assert.equal(arc.side, -1);
    assert.ok(arc.start[0] < 0, 'arc start must be on the right (-X) side');
    assert.ok(arc.end[0] <= 0, 'mirrored target must not cross to the opposite side');
  }
  // 重建后 DOM 标签数量保持与靶区一致，旧侧标签已 remove。
  assert.equal(container.children.length, info.targets.length);
  assert.equal(layer.active, true);

  layer.clear();
  assert.equal(layer.active, false);
  assert.equal(layer.side, null);
  assert.equal(scene.children.every(group => group.children.length === 0), true);
  assert.equal(container.children.length, 0);
});

function collectGeometries(group) {
  const geometries = [];
  group.traverse(obj => {
    // Sprite 几何体是 Three.js 内置共享资源，图层生命周期不负责释放它。
    if (obj.geometry && !obj.isSprite) geometries.push(obj.geometry);
  });
  return geometries;
}

function collectTextures(group) {
  const textures = [];
  group.traverse(obj => {
    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const material of materials) {
      if (material.map) textures.push(material.map);
    }
  });
  return textures;
}

test('rapid side switching disposes every replaced geometry and material without leaks', () => {
  const {scene, layer} = createLayer();
  const disposedMaterials = new WeakSet();
  const disposedGeometries = new WeakSet();
  const originalMaterialDispose = THREE.Material.prototype.dispose;
  const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
  THREE.Material.prototype.dispose = function () {
    disposedMaterials.add(this);
    return originalMaterialDispose.call(this);
  };
  THREE.BufferGeometry.prototype.dispose = function () {
    disposedGeometries.add(this);
    return originalGeometryDispose.call(this);
  };

  const rounds = [];
  try {
    for (let i = 0; i < 25; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      layer.show({code: BILATERAL_CODE}, startPoint(side), side);
      rounds.push({
        side,
        materials: new Set(collectMaterials(scene)),
        geometries: new Set(collectGeometries(scene))
      });

      // 除当前轮外，历史轮次的全部材质/几何体都必须已随 clear() 释放，不允许存活或泄漏。
      for (let j = 0; j < i; j++) {
        for (const material of rounds[j].materials) {
          assert.equal(disposedMaterials.has(material), true, `round ${j} material leaked after rebuild`);
        }
        for (const geometry of rounds[j].geometries) {
          assert.equal(disposedGeometries.has(geometry), true, `round ${j} geometry leaked after rebuild`);
        }
      }
      // 当前存活资源绝不能已被释放（无悬空引用）。
      for (const material of rounds[i].materials) assert.equal(disposedMaterials.has(material), false);
      for (const geometry of rounds[i].geometries) assert.equal(disposedGeometries.has(geometry), false);
    }

    // 最终 clear 后最后一轮资源也要释放，且场景与标签容器全部清空。
    layer.clear();
    for (const material of rounds[rounds.length - 1].materials) assert.equal(disposedMaterials.has(material), true);
    for (const geometry of rounds[rounds.length - 1].geometries) assert.equal(disposedGeometries.has(geometry), true);
    assert.equal(scene.children.every(group => group.children.length === 0), true);
    assert.equal(layer.active, false);
  } finally {
    THREE.Material.prototype.dispose = originalMaterialDispose;
    THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
    layer.dispose();
  }
});

test('shared glow texture stays alive across rebuilds and is released only by full dispose', () => {
  const {scene, layer} = createLayer();
  layer.show({code: BILATERAL_CODE}, startPoint(1), 1);
  const glowTextures = new Set(collectTextures(scene));
  assert.ok(glowTextures.size >= 1, 'bead sprites share the radial glow texture');

  const disposed = new WeakSet();
  const original = THREE.Texture.prototype.dispose;
  THREE.Texture.prototype.dispose = function () {
    disposed.add(this);
    return original.call(this);
  };
  try {
    // 连续多轮切侧重建：共享贴图不能随旧图层一起释放，否则新粒子将引用已销毁贴图。
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      layer.show({code: BILATERAL_CODE}, startPoint(side), side);
    }
    for (const texture of glowTextures) assert.equal(disposed.has(texture), false);
    layer.clear();
    for (const texture of glowTextures) assert.equal(disposed.has(texture), false);

    layer.dispose();
    for (const texture of glowTextures) assert.equal(disposed.has(texture), true);
  } finally {
    THREE.Texture.prototype.dispose = original;
  }
});

test('sprite materials using the shared glow texture are disposed while the texture is retained', () => {
  const {scene, layer} = createLayer();
  layer.show({code: BILATERAL_CODE}, startPoint(1), 1);

  const spriteMaterials = [];
  scene.traverse(obj => {
    if (obj.isSprite && obj.material) spriteMaterials.push(obj.material);
  });
  assert.ok(spriteMaterials.length >= 6, 'each target carries animated bead sprites');

  const disposed = [];
  for (const material of spriteMaterials) {
    const original = material.dispose.bind(material);
    material.dispose = () => { disposed.push(material); original(); };
  }
  layer.clear();
  assert.equal(disposed.length, spriteMaterials.length, 'sprite materials must be disposed (previous leak regression)');
  layer.dispose();
});

test('pause and enabled state survive side-driven rebuilds and full-path framing', () => {
  const {layer} = createLayer();
  layer.show({code: BILATERAL_CODE}, startPoint(1), 1);

  layer.setPaused(true);
  layer.setEnabled(false);
  assert.equal(layer.paused, true);
  assert.equal(layer.enabled, false);

  // 切侧重建不得重置暂停/显示状态。
  layer.show({code: BILATERAL_CODE}, startPoint(-1), -1);
  assert.equal(layer.paused, true);
  assert.equal(layer.enabled, false);
  assert.equal(layer.side, -1);

  layer.setEnabled(true);
  assert.equal(layer.enabled, true);
  assert.equal(layer.paused, true);

  // update() 在暂停时仍返回引线布局数据，且不推进动画时间。
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 4.3, 12);
  camera.lookAt(0, 4.3, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const leadersA = layer.update(1000, camera, 800, 600);
  const leadersB = layer.update(2000, camera, 800, 600);
  assert.ok(Array.isArray(leadersA));
  assert.equal(leadersA.length, leadersB.length);
});

test('midline acupoint associations are available on either side without hidden-side data', () => {
  assert.ok(associations[MIDLINE_CODE]);
  const {layer, container} = createLayer();
  layer.show({code: MIDLINE_CODE}, new THREE.Vector3(0, 5.64, 0.37), 1);
  assert.equal(layer.active, true);
  const firstCount = container.children.length;
  assert.ok(firstCount > 0);

  layer.show({code: MIDLINE_CODE}, new THREE.Vector3(0, 5.64, 0.37), -1);
  assert.equal(container.children.length, firstCount, 'midline point keeps identical arc count per side');
  layer.dispose();
});

test('show without association or start point leaves an empty layer', () => {
  const {scene, container, layer} = createLayer();
  const baselineChildren = scene.children.length; // createEffects 自身挂载的空 group
  layer.show({code: 'UNKNOWN'}, startPoint(1), 1);
  assert.equal(layer.active, false);
  assert.equal(scene.children.length, baselineChildren);
  assert.equal(container.children.length, 0);
  layer.dispose();
});
