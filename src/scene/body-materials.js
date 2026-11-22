import * as T from '../vendor/three.module.js';

// 四种东方博物级人体材质预设。
// 纯参数预设与应用函数：只修改既有材质/ uniform，不创建新几何体、材质或贴图，
// 因此着色器重编译期间三维舞台的观察侧等状态完全不受影响（由 stage-state 统一持有）。

export const BODY_MATERIAL_MODES = ['jade', 'bronze', 'xray', 'ivory'];

export const BODY_MATERIAL_PRESETS = {
  jade: {
    skin: {color: 0x143840, emissive: 0x05181e, emissiveIntensity: 0.55, roughness: 0.44, metalness: 0.08, clearcoat: 0.24, clearcoatRoughness: 0.42, sheen: 0.75, sheenColor: 0x6ef2de, sheenRoughness: 0.45, transparent: true, opacity: 0.95},
    eye: {color: 0x88e8dc},
    wire: {color: 0x6ef2de, opacity: 0.032},
    uniforms: {uRimColor: 0x6ef2de, uRimPower: 2.35, uRimStrength: 0.85, uPatinaStrength: 0.0, uScanStrength: 0.34, uContourStrength: 0.09, uXrayFade: 0.0}
  },
  bronze: {
    skin: {color: 0x8a643b, emissive: 0x160d05, emissiveIntensity: 0.35, roughness: 0.34, metalness: 0.82, clearcoat: 0.18, clearcoatRoughness: 0.38, sheen: 0.3, sheenColor: 0xf5cc7e, sheenRoughness: 0.45, transparent: false, opacity: 1.0},
    eye: {color: 0xd6b078},
    wire: {color: 0xf5cc7e, opacity: 0.024},
    uniforms: {uRimColor: 0xf5cc7e, uRimPower: 2.8, uRimStrength: 0.52, uPatinaColor: 0x479e8e, uPatinaStrength: 0.28, uScanStrength: 0.08, uContourStrength: 0.02, uXrayFade: 0.0}
  },
  xray: {
    skin: {color: 0x061018, emissive: 0x020912, emissiveIntensity: 0.35, roughness: 0.55, metalness: 0.1, clearcoat: 0.1, clearcoatRoughness: 0.5, sheen: 0.4, sheenColor: 0x52c8ff, sheenRoughness: 0.4, transparent: true, opacity: 1.0},
    eye: {color: 0x7be0ff},
    wire: {color: 0x64d6ff, opacity: 0.065},
    uniforms: {uRimColor: 0x64d6ff, uRimPower: 1.85, uRimStrength: 1.25, uPatinaStrength: 0.0, uScanStrength: 0.45, uContourStrength: 0.22, uXrayFade: 0.92}
  },
  ivory: {
    skin: {color: 0xd8c8b6, emissive: 0x1f140d, emissiveIntensity: 0.18, roughness: 0.56, metalness: 0.02, clearcoat: 0.08, clearcoatRoughness: 0.6, sheen: 0.45, sheenColor: 0xffe6d4, sheenRoughness: 0.65, transparent: false, opacity: 1.0},
    eye: {color: 0xf2e9de},
    wire: {color: 0xffffff, opacity: 0.014},
    uniforms: {uRimColor: 0x88b4c4, uRimPower: 3.0, uRimStrength: 0.32, uPatinaStrength: 0.0, uScanStrength: 0.05, uContourStrength: 0.015, uXrayFade: 0.0}
  }
};

const COLOR_KEYS = new Set(['color', 'emissive', 'sheenColor']);

function applyScalar(target, key, value) {
  if (COLOR_KEYS.has(key)) {
    if (target[key] && target[key].isColor) target[key].setHex(value);
    else target[key] = new T.Color(value);
  } else {
    target[key] = value;
  }
}

/**
 * 将预设应用到现有材质实例（原地修改，不新建材质/贴图/几何体）。
 * @returns 应用前的观察侧，便于调用方断言材质切换前后舞台状态一致。
 */
export function applyBodyMaterial(mode, {skin, eye, wireMaterial, uniforms, stage}) {
  const preset = BODY_MATERIAL_PRESETS[mode];
  if (!preset) throw new Error(`Unknown body material mode: ${mode}`);
  const sideBefore = stage ? stage.side : undefined;

  for (const [key, value] of Object.entries(preset.skin)) applyScalar(skin, key, value);
  for (const [key, value] of Object.entries(preset.eye)) applyScalar(eye, key, value);
  if (wireMaterial) {
    for (const [key, value] of Object.entries(preset.wire)) applyScalar(wireMaterial, key, value);
  }
  for (const [key, value] of Object.entries(preset.uniforms)) {
    const uniform = uniforms[key];
    if (!uniform) continue;
    if (uniform.value && uniform.value.isColor) uniform.value.setHex(value);
    else uniform.value = value;
  }
  skin.needsUpdate = true;
  eye.needsUpdate = true;

  if (stage && stage.side !== sideBefore) {
    throw new Error('Body material switch must not mutate the observation side');
  }
  return sideBefore;
}
