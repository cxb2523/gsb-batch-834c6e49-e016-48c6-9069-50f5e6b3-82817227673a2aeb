// Cross-frame state lifecycle of the stochastic splat renderer. The invariant under test:
// a view's TAA history, previous-frame matrices, occlusion grid and projected cache are all
// valid together, and any change of target size, projection type, renderer enablement,
// stereo/mono mode or history colour format invalidates them together before the next frame
// can read them; camera motion and resident-set changes alone keep the history.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { destroyed, installHooks, live } from './helpers/mock-playcanvas.mjs';

installHooks();

const { makeEyes, makeResidentSet, makeWorld } = await import('./helpers/renderer-harness.mjs');

const viewOf = (renderer, index = 0) => renderer.views[index];

describe('stochastic renderer cross-frame state', () => {
    beforeEach(() => {
        destroyed.clear();
        live.clear();
    });

    describe('frame identity (frame-state.ts)', () => {
        it('treats every identity field as significant', async () => {
            const { sameFrameIdentity } = await import('../../src/render/frame-state.ts');
            const base = {
                width: 128,
                height: 96,
                orthographic: false,
                rendererEnabled: true,
                stereo: false,
                historyHalf: false
            };
            assert.equal(sameFrameIdentity(null, base), false, 'a fresh view has no valid frame');
            assert.equal(sameFrameIdentity(base, { ...base }), true);
            for (const key of Object.keys(base)) {
                const changed = { ...base };
                if (typeof base[key] === 'boolean') changed[key] = !base[key];
                else changed[key] = base[key] + 1;
                assert.equal(sameFrameIdentity(base, changed), false, `a changed ${key} must break the identity`);
            }
        });
    });

    describe('mono accumulation', () => {
        it('converges at rest: the history stays valid and accumulates across frames', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame } = world;

            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHistoryValid, true, 'the first accumulating frame starts a history');
            assert.equal(view.prevValid, true, 'the first frame becomes the previous one');
            assert.equal(renderer.taaActive, true);

            const writeAfterFirst = view.taaWrite;
            const identityAfterFirst = { ...view.frameIdentity };
            fireFrame();
            assert.equal(view.taaHistoryValid, true, 'the second resting frame keeps the history');
            assert.equal(view.taaWrite, writeAfterFirst ^ 1, 'the ping-pong swaps each frame');
            assert.deepEqual(view.frameIdentity, identityAfterFirst, 'the identity is unchanged at rest');
            const restAfterTwo = view.restFrames;
            assert.ok(restAfterTwo >= 1, 'a resting frame accrues rest frames');
            fireFrame();
            assert.equal(view.restFrames, restAfterTwo + 1, 'rest frames accumulate while the camera is still');
            assert.equal(view.taaHistoryValid, true, 'the history keeps converging across rest frames');
            renderer.destroy();
        });

        it('keeps the history across camera motion but shortens its weight', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, camera } = world;

            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHistoryValid, true);

            // move the camera: change the view matrix's translation beyond the noise threshold
            camera.viewMatrix.data[12] = 0.5;
            fireFrame();
            assert.equal(view.taaHistoryValid, true, 'a moving camera reuses the history');
            assert.equal(view.restFrames, 0, 'a move restarts the rest counter (shorter weight)');
            assert.equal(view.prevValid, true, 'the previous frame stays valid for reprojection');
            renderer.destroy();
        });

        it('keeps the history when only the resident set changes', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame } = world;

            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHistoryValid, true);

            const nextSet = makeResidentSet(2, 2048);
            fireFrame({ set: nextSet, changed: true });
            assert.equal(view.taaHistoryValid, true, 'streamed content keeps the history');
            assert.equal(view.restFrames, 0, 'a changed set shortens the weight once');
            renderer.destroy();
        });
    });

    describe('target size changes', () => {
        it('invalidates every cross-frame state on the first resized frame, with no ghost', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            fireFrame();
            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHistoryValid, true);
            assert.equal(view.prevValid, true);
            const oldCache = view.cacheBuffer;
            assert.ok(oldCache, 'a projected cache exists before the resize');

            // the resized frame must run the identity invalidation before any pass can read the
            // old target's history, depth grid or projected cache
            fireFrame({ width: 256, height: 192 });
            assert.equal(invalidations.length, 1, 'the changed size triggers one invalidation');
            const event = invalidations[0];
            assert.equal(event.view, view);
            assert.equal(event.hadHistory, true, 'a converged history existed and was dropped');
            assert.equal(event.hadPrevFrame, true, 'the previous frame / cull grid was dropped');
            assert.equal(event.oldIdentity.width, 128, 'the dropped identity was the old size');
            assert.equal(oldCache.destroyed, true, 'the old projection cache is released');

            // the frame then rebuilds under the new identity and accumulates afresh
            assert.equal(view.taaHistoryValid, true);
            assert.equal(view.prevValid, true);
            assert.notEqual(view.cacheBuffer, oldCache, 'the resize rebuilds the projected cache');
            assert.equal(view.frameIdentity.width, 256, 'the new identity records the resized target');

            // a following same-size frame must not invalidate again
            fireFrame();
            assert.equal(invalidations.length, 0, 'an unchanged size keeps the rebuilt state');
            assert.equal(view.taaHistoryValid, true);
            renderer.destroy();
        });

        it('gates the shader so an invalidating frame samples no old history', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, historyBit } = world;

            fireFrame();
            fireFrame();
            assert.equal(historyBit(), 1, 'a converged resting frame feeds the history to the shader');

            fireFrame({ width: 256, height: 192 });
            assert.equal(
                historyBit(),
                0,
                'the resized frame tells the shader no history is valid, so no ghost is sampled'
            );

            fireFrame();
            assert.equal(historyBit(), 1, 'the rebuilt history is trusted again next frame');
            renderer.destroy();
        });
    });

    describe('renderer disable / enable', () => {
        it('rebuilds from scratch after being switched off and on again', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame } = world;

            fireFrame();
            const firstView = viewOf(renderer);
            const oldColor = firstView.colorTexture;
            const oldCache = firstView.cacheBuffer;
            assert.ok(oldCache);

            renderer.setEnabled(false);
            assert.equal(oldColor.destroyed, true, 'disabling releases the view targets');
            assert.equal(oldCache.destroyed, true, 'disabling releases the projected cache');

            renderer.setEnabled(true);
            const newView = viewOf(renderer);
            assert.notEqual(newView, firstView, 're-enabling makes a fresh view');
            assert.equal(newView.taaHistoryValid, false, 'the fresh view has no history');
            assert.equal(newView.prevValid, false);
            assert.equal(newView.frameIdentity, null);

            // the first frame must not touch any destroyed resource
            assert.doesNotThrow(() => fireFrame());
            assert.equal(newView.taaHistoryValid, true, 'the first re-enabled frame starts clean');
            assert.equal(newView.prevValid, true);
            assert.equal(renderer.taaActive, true, 'the debug observable keeps its meaning');
            renderer.destroy();
        });
    });

    describe('stereo XR sessions', () => {
        it('grows and shrinks the views and never reuses eye data in mono', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            fireFrame();
            assert.equal(renderer.views.length, 1, 'mono starts with one view');
            const monoView = viewOf(renderer);
            fireFrame();
            assert.equal(monoView.taaHistoryValid, true);

            // enter stereo: the engine keeps the index-0 view and adds one per extra eye. Every
            // view nonetheless starts the session without a usable history: a new eye is built
            // fresh (no identity), and the reused lead's identity changes so its mono state is
            // invalidated before its first stereo frame
            const eyes = makeEyes();
            const constructed = [];
            const originalPush = renderer.views.push.bind(renderer.views);
            renderer.views.push = (view) => {
                // snapshot the brand-new view's state at construction, before any frame runs
                constructed.push({
                    view,
                    taaHistoryValid: view.taaHistoryValid,
                    prevValid: view.prevValid,
                    frameIdentity: view.frameIdentity,
                    cacheBuffer: view.cacheBuffer
                });
                return originalPush(view);
            };
            fireFrame({ xrViews: eyes });
            renderer.views.push = originalPush;

            assert.equal(renderer.views.length, 2, 'the session gets one view per eye');
            assert.equal(constructed.length, 1, 'the second eye is a freshly constructed view');
            for (const fresh of constructed) {
                assert.equal(fresh.taaHistoryValid, false, 'a new eye carries no mono history');
                assert.equal(fresh.prevValid, false, 'a new eye carries no previous frame');
                assert.equal(fresh.frameIdentity, null, 'a new eye has no frame identity until its frame');
                assert.equal(fresh.cacheBuffer, null, 'a new eye has no projected cache until it projects');
            }
            for (const view of renderer.views) {
                assert.equal(view.frameIdentity.stereo, true);
            }
            // the reused lead must not read its mono history in a stereo frame
            const lead = viewOf(renderer, 0);
            assert.equal(
                invalidations.some((event) => event.view === lead && event.oldIdentity?.stereo === false),
                true,
                "the lead's mono identity is invalidated when it becomes an eye"
            );
            assert.notEqual(lead, constructed[0].view, 'the lead is the reused view, the other is a fresh eye');
            assert.equal(monoView, lead, 'the index-0 view object is reused');

            fireFrame({ xrViews: eyes, viewIndex: 0 });
            assert.equal(renderer.views.length, 2);
            for (const view of renderer.views) {
                assert.equal(view.taaHistoryValid, true, 'each eye accumulates its own history');
            }
            const eyeCaches = renderer.views.map((view) => view.cacheBuffer);
            assert.notEqual(eyeCaches[0], eyeCaches[1], 'the eyes keep separate projected caches');

            // leave the session: the extra eye view is destroyed and the lead becomes a mono view
            const eyeViews = [...renderer.views];
            const follower = eyeViews[1];
            fireFrame({ xr: false });
            assert.equal(renderer.views.length, 1, 'mono is back to one view');
            assert.equal(follower.destroyed, true, 'the removed eye view releases everything');
            const monoAgain = viewOf(renderer);
            assert.equal(monoAgain.frameIdentity.stereo, false);
            assert.equal(
                invalidations.some((event) => event.view === monoAgain && event.oldIdentity?.stereo === true),
                true,
                "the lead's eye identity is invalidated when it becomes mono again"
            );
            // that frame's pass ran with history trusted off, so no eye colour was folded in
            assert.equal(
                invalidations.some((event) => event.view === monoAgain && event.hadHistory),
                true,
                'the eye history existed and was explicitly not trusted in the first mono frame'
            );

            fireFrame({ xr: false });
            assert.equal(monoAgain.taaHistoryValid, true, 'mono accumulates independently again');
            assert.equal(invalidations.length, 0, 'a continued mono frame keeps its history');
            renderer.destroy();
        });
    });

    describe('history colour format', () => {
        it('does not read an old-format texture after a taaHistory switch', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHalf, false, 'mono defaults to fixed point');
            const oldTextures = [...view.taaColor];
            assert.ok(oldTextures.every((texture) => !texture.destroyed));

            renderer.setVariant('taaHistory:half');
            fireFrame();
            assert.equal(view.taaHalf, true, 'the view switches to half floats');
            for (const texture of oldTextures) {
                assert.equal(texture.destroyed, true, 'the fixed-point history textures are destroyed');
            }
            assert.ok(view.taaColor.every((texture) => !texture.destroyed));
            assert.equal(
                invalidations.length >= 1,
                true,
                'the historyHalf identity change invalidates the cross-frame state before the frame reads it'
            );
            assert.equal(view.frameIdentity.historyHalf, true);
            // the frame rebuilt a history in the new format; nothing points at a destroyed texture
            assert.equal(view.taaHistoryValid, true);
            assert.ok(view.taaColor.every((texture) => !texture.destroyed));

            fireFrame();
            assert.equal(view.taaHistoryValid, true, 'accumulation continues in the new format');
            assert.equal(invalidations.length, 0, 'no further invalidation while the format holds');
            renderer.destroy();
        });
    });

    describe('projection type changes', () => {
        it('invalidates the cull and history when perspective switches to orthographic', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            fireFrame();
            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.prevValid, true);
            const oldCache = view.cacheBuffer;

            fireFrame({ orthographic: true });
            assert.equal(view.frameIdentity.orthographic, true);
            assert.equal(
                invalidations.some((event) => event.view === view && event.hadPrevFrame),
                true,
                'the projection-type change drops the previous frame'
            );
            assert.equal(oldCache.destroyed, true, 'the perspective projection cache is released');
            assert.equal(renderer.culling, false, 'the first ortho frame does not cull');
            // rebuilt fresh under the orthographic identity
            assert.equal(view.prevValid, true);
            assert.equal(view.taaHistoryValid, true);
            renderer.destroy();
        });
    });

    describe('capture / query frames', () => {
        it('keeps the TAA history across a same-size capture but drops the cull grid', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame } = world;

            fireFrame();
            fireFrame();
            const view = viewOf(renderer);
            assert.equal(view.taaHistoryValid, true);
            assert.equal(view.prevValid, true);

            // a harness capture at the on-screen size is allowed to accumulate
            renderer.allowQueryTaa = true;
            const target = { width: 128, height: 96, flipY: false };
            fireFrame({ renderTarget: target });

            assert.equal(view.taaHistoryValid, true, 'the same-size capture keeps the history');
            assert.equal(view.prevValid, false, "a capture cannot back the next frame's cull");
            assert.equal(renderer.culling, false, 'the capture frame never culls');

            // the next on-screen frame matches the unchanged identity: history kept, only the
            // cull needs a fresh grid
            fireFrame();
            assert.equal(view.taaHistoryValid, true, 'the on-screen frame continues the history');
            assert.equal(view.prevValid, true, 'the cull grid is rebuilt for the on-screen frame');
            renderer.allowQueryTaa = false;
            renderer.destroy();
        });

        it('invalidates when a capture changes the target size', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            fireFrame();
            fireFrame();
            const view = viewOf(renderer);

            const target = { width: 300, height: 200, flipY: false };
            fireFrame({ renderTarget: target });
            // the different size changes the frame identity, so the on-screen-sized state is dropped
            assert.equal(
                invalidations.some((event) => event.view === view),
                true,
                'a different-sized capture changes the frame identity'
            );
            renderer.destroy();
        });
    });

    describe('resource lifecycle', () => {
        afterEach(() => {
            // every gpu object a test's renderer made must be gone after destroy
            const leaked = [...live].filter((object) => !object.destroyed);
            assert.equal(leaked.length, 0, `leaked gpu objects: ${leaked.map((o) => o.name).join(', ')}`);
        });

        it('releases a removed eye view including its projector computes', async () => {
            // separate stereo gives each eye its own projection, cache and projector computes
            const world = await makeWorld({ variant: 'stereo:separate' });
            const { renderer, fireFrame } = world;

            const eyes = makeEyes();
            fireFrame({ xrViews: eyes });
            fireFrame({ xrViews: eyes });
            assert.equal(renderer.views.length, 2);
            const eyeViews = [...renderer.views];
            for (const [i, view] of eyeViews.entries()) {
                assert.ok(view.projectorComputes.size > 0, `eye ${i} ran its own projector computes`);
                assert.ok(view.cacheBuffer, `eye ${i} has its own projected cache`);
            }
            // the second eye is removed outright when the session ends; the lead (index 0) is
            // rebuilt in place as the mono view
            const removedEye = eyeViews[1];
            const removedComputes = [...removedEye.projectorComputes.values()];
            const removedCache = removedEye.cacheBuffer;
            const removedDepth = removedEye.depthTexture;
            const removedTarget = removedEye.target;

            fireFrame({ xr: false });
            assert.equal(renderer.views.length, 1);
            assert.equal(removedEye.destroyed, true, 'the removed eye view is destroyed');
            for (const compute of removedComputes) {
                assert.equal(compute.destroyed, true, 'the removed eye projector compute is destroyed');
            }
            assert.equal(removedCache.destroyed, true, 'the removed eye cache is destroyed');
            assert.equal(removedDepth.destroyed, true);
            assert.equal(removedTarget.destroyed, true);
            renderer.destroy();
        });

        it('releases the removed follower and rebuilds the lead as a clean mono view', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame, invalidations } = world;

            const eyes = makeEyes();
            fireFrame({ xrViews: eyes });
            fireFrame({ xrViews: eyes });
            const lead = viewOf(renderer, 0);
            const follow = viewOf(renderer, 1);
            assert.ok(lead.projectorComputes.size > 0, 'the lead eye owns the shared projection');
            assert.equal(follow.projectorComputes.size, 0, 'the follower draws the lead cache');

            fireFrame({ xr: false });
            assert.equal(renderer.views.length, 1);
            assert.equal(follow.destroyed, true, 'the follower view is destroyed with the session');
            // the surviving index-0 view is rebuilt as mono: its stereo identity changes, so its
            // eye history is invalidated and that frame's pass trusts no history (no ghost)
            const mono = viewOf(renderer);
            assert.equal(mono.frameIdentity.stereo, false, 'the surviving view is a mono view again');
            assert.equal(
                invalidations.some((event) => event.view === mono && event.oldIdentity?.stereo === true),
                true,
                "the lead's eye identity is invalidated on the mono transition"
            );
            renderer.destroy();
        });

        it('leaves no gpu object behind across the full lifecycle', async () => {
            const world = await makeWorld();
            const { renderer, fireFrame } = world;
            const eyes = makeEyes();

            fireFrame();
            fireFrame({ width: 200, height: 100 });
            fireFrame({ xrViews: eyes });
            fireFrame({ xr: false });
            renderer.setEnabled(false);
            renderer.setEnabled(true);
            fireFrame();
            renderer.destroy();
        });
    });
});
