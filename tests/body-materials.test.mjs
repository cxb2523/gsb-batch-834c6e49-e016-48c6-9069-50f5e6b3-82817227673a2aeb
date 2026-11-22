import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from '../src/vendor/three.module.js';
import {StageState, SIDE_LEFT, SIDE_RIGHT} from '../src/scene/stage-state.js';
import {BODY_MATERIAL_MODES, BODY_MATERIAL_PRESETS, applyBodyMaterial} from '../src/scene/body-materials.js';

function createUniforms() {
  return {
    uRimColor: {value: new THREE.Color(0x6ef2de)},
    uRimPower: {value: 2.35},
    uRimStrength: {value: 0.78},
    uPatinaColor: {value: new THREE.Color(0x45a394)},
    uPatinaStrength: {value: 0.0},
    uScanStrength: {value: 0.32},
    uContourStrength: {value: 0.08},
    uXrayFade: {value: 0.0}
  };
}

function createFixture() {
  const skin = new THREE.MeshPhysicalMaterial({color: 0xc89373, roughness: 0.67, metalness: 0});
  const eye = new THREE.MeshPhysicalMaterial({color: 0xebe0d5, roughness: 0.28, metalness: 0});
  const wireMaterial = new THREE.MeshBasicMaterial({color: 0x6ef2de, wireframe: true, transparent: true, opacity: 0.032});
  const uniforms = createUniforms();
  const stage = new StageState();
  return {skin, eye, wireMaterial, uniforms, stage};
}

test('all four body material modes have complete presets', () => {
  assert.deepEqual(BODY_MATERIAL_MODES, ['jade', 'bronze', 'xray', 'ivory']);
  for (const mode of BODY_MATERIAL_MODES) {
    const preset = BODY_MATERIAL_PRESETS[mode];
    assert.ok(preset.skin && preset.eye && preset.wire && preset.uniforms, `missing preset fields for ${mode}`);
    for (const key of ['uRimColor', 'uRimPower', 'uRimStrength', 'uScanStrength', 'uContourStrength', 'uXrayFade']) {
      assert.ok(key in preset.uniforms, `${mode} preset missing uniform ${key}`);
    }
  }
});

test('applyBodyMaterial mutates existing materials in place without creating new instances', () => {
  const fixture = createFixture();
  const {skin, eye, wireMaterial, uniforms, stage} = fixture;
  const skinVersionBefore = skin.version;
  const eyeVersionBefore = eye.version;

  applyBodyMaterial('bronze', fixture);
  assert.equal(skin.color.getHex(), 0x8a643b);
  assert.equal(skin.metalness, 0.82);
  assert.equal(eye.color.getHex(), 0xd6b078);
  assert.equal(wireMaterial.opacity, 0.024);
  assert.equal(uniforms.uRimColor.value.getHex(), 0xf5cc7e);
  assert.equal(uniforms.uPatinaStrength.value, 0.28);
  assert.equal(uniforms.uPatinaColor.value.getHex(), 0x479e8e);
  // needsUpdate 是 three.js 事件型属性（设置后即清空），其效果体现为 material.version 递增。
  assert.ok(skin.version > skinVersionBefore, 'skin material must request recompilation');
  assert.ok(eye.version > eyeVersionBefore, 'eye material must request recompilation');

  applyBodyMaterial('xray', fixture);
  assert.equal(skin.transparent, true);
  assert.equal(uniforms.uXrayFade.value, 0.92);
  assert.equal(uniforms.uRimColor.value.getHex(), 0x64d6ff);
  assert.equal(wireMaterial.color.getHex(), 0x64d6ff);

  applyBodyMaterial('ivory', fixture);
  assert.equal(skin.metalness, 0.02);
  assert.equal(uniforms.uXrayFade.value, 0.0);

  applyBodyMaterial('jade', fixture);
  assert.equal(skin.color.getHex(), 0x143840);
  assert.equal(skin.sheenColor.getHex(), 0x6ef2de);
  assert.equal(uniforms.uRimColor.value.getHex(), 0x6ef2de);
  assert.equal(wireMaterial.opacity, 0.032);
});

test('observation side, pause and display switches survive every material recompilation', () => {
  const fixture = createFixture();
  const {stage} = fixture;
  stage.setSide(SIDE_RIGHT);
  stage.showEffects = false;
  stage.effectsPaused = true;
  stage.showLabels = false;

  for (const mode of BODY_MATERIAL_MODES) {
    const returnedSide = applyBodyMaterial(mode, fixture);
    assert.equal(returnedSide, SIDE_RIGHT, `${mode} must report the unchanged observation side`);
    assert.equal(stage.side, SIDE_RIGHT, `${mode} recompilation must not reset the observation side`);
    assert.equal(stage.showEffects, false);
    assert.equal(stage.effectsPaused, true);
    assert.equal(stage.showLabels, false);
  }

  // 切回左侧后再走一轮，状态仍由 StageState 独立持有。
  stage.setSide(SIDE_LEFT);
  for (const mode of BODY_MATERIAL_MODES) {
    applyBodyMaterial(mode, fixture);
    assert.equal(stage.side, SIDE_LEFT);
  }
});

test('applyBodyMaterial rejects unknown modes and works without a wireframe material', () => {
  const fixture = createFixture();
  delete fixture.wireMaterial;
  assert.doesNotThrow(() => applyBodyMaterial('jade', fixture));
  assert.throws(() => applyBodyMaterial('marble', createFixture()), /Unknown body material mode/);
});
