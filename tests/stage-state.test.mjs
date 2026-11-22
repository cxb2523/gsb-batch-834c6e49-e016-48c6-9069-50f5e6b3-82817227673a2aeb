import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StageState,
  SIDE_LEFT,
  SIDE_RIGHT,
  SIDES,
  matchesSide,
  markerVisible,
  segmentVisible,
  qiParticleVisible,
  effectTargetSide,
  createStageState
} from '../src/scene/stage-state.js';

const bilateralMarker = (side, extra = {}) => ({side, bilateral: true, p: {id: 1}, mesh: {}, ...extra});
const midlineMarker = (extra = {}) => ({side: 1, bilateral: false, p: {id: 2}, mesh: {}, ...extra});
const alwaysVisible = () => true;
const alwaysHidden = () => false;

test('StageState defaults to the left observation side with UI switches enabled', () => {
  const stage = createStageState();
  assert.equal(stage.side, SIDE_LEFT);
  assert.equal(stage.showLines, true);
  assert.equal(stage.showLabels, true);
  assert.equal(stage.showEffects, true);
  assert.equal(stage.effectsPaused, false);
  assert.deepEqual(SIDES, [SIDE_LEFT, SIDE_RIGHT]);
});

test('setSide is the only mutation path and notifies subscribers on real changes', () => {
  const stage = new StageState();
  const events = [];
  stage.subscribe((next, previous) => events.push([next, previous]));

  assert.equal(stage.setSide(SIDE_RIGHT), true);
  assert.equal(stage.side, SIDE_RIGHT);
  assert.deepEqual(events, [[SIDE_RIGHT, SIDE_LEFT]]);

  assert.equal(stage.setSide(SIDE_RIGHT), false);
  assert.equal(stage.side, SIDE_RIGHT);
  assert.deepEqual(events, [[SIDE_RIGHT, SIDE_LEFT]]);

  assert.equal(stage.setSide(SIDE_LEFT), true);
  assert.deepEqual(events, [
    [SIDE_RIGHT, SIDE_LEFT],
    [SIDE_LEFT, SIDE_RIGHT]
  ]);
});

test('rapid side toggling never collapses state or skips an opposite transition', () => {
  const stage = new StageState();
  let count = 0;
  stage.subscribe(() => count++);

  for (let i = 0; i < 50; i++) stage.setSide(i % 2 === 0 ? SIDE_RIGHT : SIDE_LEFT);
  assert.equal(count, 50);
  // 第 49 次（i=49，奇数）切回 SIDE_LEFT。
  assert.equal(stage.side, SIDE_LEFT);

  // Unsubscribing stops notifications entirely.
  const stage2 = new StageState();
  const unsubscribe = stage2.subscribe(() => count++);
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
  stage2.setSide(SIDE_RIGHT);
  assert.equal(count, 50);
});

test('StageState rejects invalid observation sides', () => {
  const stage = new StageState();
  assert.throws(() => new StageState({initialSide: 0}), /Invalid observation side/);
  assert.throws(() => stage.setSide(2), /Invalid observation side/);
});

test('matchesSide keeps midline single points on both sides and filters bilateral points', () => {
  assert.equal(matchesSide(bilateralMarker(SIDE_LEFT), SIDE_LEFT), true);
  assert.equal(matchesSide(bilateralMarker(SIDE_RIGHT), SIDE_LEFT), false);
  assert.equal(matchesSide(bilateralMarker(SIDE_LEFT), SIDE_RIGHT), false);
  assert.equal(matchesSide(bilateralMarker(SIDE_RIGHT), SIDE_RIGHT), true);

  // 正中单穴（任督二脉等）在任一观察侧都必须保留。
  assert.equal(matchesSide(midlineMarker(), SIDE_LEFT), true);
  assert.equal(matchesSide(midlineMarker(), SIDE_RIGHT), true);
});

test('markerVisible composes catalog filtering and observation-side filtering', () => {
  const left = bilateralMarker(SIDE_LEFT);
  const right = bilateralMarker(SIDE_RIGHT);

  assert.equal(markerVisible(left, SIDE_LEFT, alwaysVisible), true);
  assert.equal(markerVisible(right, SIDE_LEFT, alwaysVisible), false);
  assert.equal(markerVisible(midlineMarker(), SIDE_RIGHT, alwaysVisible), true);

  // 目录/搜索筛选隐藏时，即便侧别匹配也不可见。
  assert.equal(markerVisible(left, SIDE_LEFT, alwaysHidden), false);
  assert.equal(markerVisible(midlineMarker(), SIDE_LEFT, alwaysHidden), false);
});

test('segmentVisible hides opposite-side meridian tubes and honors the line switch', () => {
  const leftA = bilateralMarker(SIDE_LEFT);
  const leftB = bilateralMarker(SIDE_LEFT, {p: {id: 3}});
  const rightA = bilateralMarker(SIDE_RIGHT);
  const rightB = bilateralMarker(SIDE_RIGHT, {p: {id: 4}});
  const midA = midlineMarker();
  const midB = midlineMarker({p: {id: 5}});

  const leftSeg = {side: SIDE_LEFT, bilateral: true, points: [leftA, leftB]};
  const rightSeg = {side: SIDE_RIGHT, bilateral: true, points: [rightA, rightB]};
  const midSeg = {side: 1, bilateral: false, points: [midA, midB]};

  assert.equal(segmentVisible(leftSeg, SIDE_LEFT, alwaysVisible, true), true);
  assert.equal(segmentVisible(rightSeg, SIDE_LEFT, alwaysVisible, true), false);
  assert.equal(segmentVisible(leftSeg, SIDE_RIGHT, alwaysVisible, true), false);
  assert.equal(segmentVisible(rightSeg, SIDE_RIGHT, alwaysVisible, true), true);
  assert.equal(segmentVisible(midSeg, SIDE_RIGHT, alwaysVisible, true), true);

  // 显示开关关闭时所有光路（含正中单穴管路）一律隐藏。
  assert.equal(segmentVisible(leftSeg, SIDE_LEFT, alwaysVisible, false), false);
  assert.equal(segmentVisible(midSeg, SIDE_LEFT, alwaysVisible, false), false);

  // 任一标记被目录筛选隐藏，整条光路隐藏，不引用已隐藏侧/已过滤数据。
  assert.equal(segmentVisible(leftSeg, SIDE_LEFT, alwaysHidden, true), false);
});

test('qiParticleVisible follows its owning segment so hidden-side particles disappear', () => {
  const leftSeg = {side: SIDE_LEFT, bilateral: true, points: [bilateralMarker(SIDE_LEFT)]};
  const rightSeg = {side: SIDE_RIGHT, bilateral: true, points: [bilateralMarker(SIDE_RIGHT)]};
  const midSeg = {side: 1, bilateral: false, points: [midlineMarker()]};

  assert.equal(qiParticleVisible({seg: leftSeg}, SIDE_LEFT, alwaysVisible, true), true);
  assert.equal(qiParticleVisible({seg: rightSeg}, SIDE_LEFT, alwaysVisible, true), false);
  assert.equal(qiParticleVisible({seg: midSeg}, SIDE_RIGHT, alwaysVisible, true), true);
  assert.equal(qiParticleVisible({seg: leftSeg}, SIDE_LEFT, alwaysVisible, false), false);
});

test('effectTargetSide reflects mirrored target vectors and falls back to current side', () => {
  assert.equal(effectTargetSide({x: 0.4}, SIDE_LEFT), 1);
  assert.equal(effectTargetSide({x: -0.4}, SIDE_LEFT), -1);
  // 正中靶区（x === 0）跟随当前观察侧，保证弧线起点与靶区同属一侧。
  assert.equal(effectTargetSide({x: 0}, SIDE_RIGHT), SIDE_RIGHT);
  assert.equal(effectTargetSide(null, SIDE_LEFT), SIDE_LEFT);
});

test('paused and display switches survive side transitions on the shared state', () => {
  const stage = createStageState();
  stage.showEffects = false;
  stage.effectsPaused = true;
  stage.showLabels = false;
  stage.setSide(SIDE_RIGHT);
  assert.equal(stage.side, SIDE_RIGHT);
  assert.equal(stage.showEffects, false);
  assert.equal(stage.effectsPaused, true);
  assert.equal(stage.showLabels, false);
});
