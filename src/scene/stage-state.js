// 三维舞台统一状态源（single source of truth）。
// 观察侧（人体左/右）、显示开关、暂停等舞台状态全部收敛到 StageState，
// 标记、经脉光路、经气粒子、主治流光、引线标签只能通过本模块的谓词过滤，
// 不得自行读取 DOM 控件值或引用已隐藏侧的数据。

export const SIDE_LEFT = 1;   // 人体左侧（世界坐标 +X）
export const SIDE_RIGHT = -1; // 人体右侧（世界坐标 -X）
export const SIDES = [SIDE_LEFT, SIDE_RIGHT];

/**
 * 图层条目是否属于当前观察侧。
 * 正中单穴（任督二脉/奇穴等 bilateral === false 的条目，约定 side === 1）两侧均可见。
 */
export function matchesSide(entry, side) {
  if (!entry || entry.bilateral === false) return true;
  return entry.side === side;
}

/** 穴位标记可见性：先过目录筛选（visibleFilter），再过观察侧。 */
export function markerVisible(marker, side, visibleFilter) {
  if (!matchesSide(marker, side)) return false;
  return visibleFilter ? visibleFilter(marker.p) : true;
}

/** 经脉光路可见性：两端标记均可见、属于当前侧，且受显示开关控制。 */
export function segmentVisible(seg, side, visibleFilter, showLines) {
  if (!showLines) return false;
  if (!matchesSide(seg, side)) return false;
  return seg.points.every(m => markerVisible(m, side, visibleFilter));
}

/**
 * 经气粒子可见性：只跟随所属光路的当前可见性。
 * 粒子按当前所选经脉一次性双侧构建，切侧时仅切换可见性，不重新分配任何几何体/材质。
 */
export function qiParticleVisible(particle, side, visibleFilter, showLines) {
  return segmentVisible(particle.seg, side, visibleFilter, showLines);
}

/** 主治流光弧线的靶区侧别（与 effects.js 内部 end.x = raw.x * side 保持一致）。 */
export function effectTargetSide(targetVector, side) {
  return targetVector && targetVector.x !== 0 ? Math.sign(targetVector.x) : side;
}

/**
 * 舞台状态容器。setSide() 是观察侧的唯一变更入口；
 * 订阅者在侧别真正变化时收到通知，用于重建主治流光等需要按侧重建的图层。
 */
export class StageState {
  constructor({initialSide = SIDE_LEFT, showLines = true, showLabels = true, showEffects = true, effectsPaused = false} = {}) {
    if (!SIDES.includes(initialSide)) throw new Error(`Invalid observation side: ${initialSide}`);
    this._side = initialSide;
    this.showLines = showLines;
    this.showLabels = showLabels;
    this.showEffects = showEffects;
    this.effectsPaused = effectsPaused;
    this._listeners = new Set();
  }

  get side() {
    return this._side;
  }

  /** 切换观察侧；侧别未变时不触发通知，保证连续快速切换不会产生重复重建。 */
  setSide(nextSide) {
    if (!SIDES.includes(nextSide)) throw new Error(`Invalid observation side: ${nextSide}`);
    if (nextSide === this._side) return false;
    const previous = this._side;
    this._side = nextSide;
    for (const listener of this._listeners) {
      listener(nextSide, previous);
    }
    return true;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}

/** 与 index.html 控件默认值保持一致的工厂。 */
export function createStageState() {
  return new StageState({
    initialSide: SIDE_LEFT,
    showLines: true,
    showLabels: true,
    showEffects: true,
    effectsPaused: false
  });
}
