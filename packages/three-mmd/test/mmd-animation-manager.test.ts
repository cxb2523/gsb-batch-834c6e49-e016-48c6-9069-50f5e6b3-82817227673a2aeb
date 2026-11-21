import { PmxObject } from 'babylon-mmd/esm/Loader/Parser/pmxObject'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from 'three'
import { describe, expect, it, vi } from 'vitest'

import { buildAnimation, MMD, MMDAnimationManager } from '../src'

const createMmd = (name: string) => {
  const bone = new Bone()
  bone.name = name

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(bone)
  mesh.bind(new Skeleton([bone]))

  const pmx: PmxObject = {
    bones: [{
      appendTransform: undefined,
      axisLimit: undefined,
      englishName: name,
      externalParentTransform: undefined,
      flag: 0,
      ik: undefined,
      localVector: undefined,
      name,
      parentBoneIndex: -1,
      position: [0, 0, 0],
      tailPosition: [0, 0, 0],
      transformOrder: 0,
    }],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: name,
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }

  return new MMD(pmx, mesh)
}

const createClip = (name: string) =>
  new AnimationClip(name, 1, [new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0])])

const createCameraClip = () =>
  new AnimationClip('camera animation', 1, [
    new VectorKeyframeTrack('target.position', [0, 1], [0, 0, -1, 1, 2, -3]),
    new NumberKeyframeTrack('.fov', [0, 1], [30, 60]),
  ])

const createAudio = (bufferDuration?: number) => {
  let playing = false
  const play = vi.fn(() => {
    playing = true
  })
  const stop = vi.fn(() => {
    playing = false
  })
  const audio = {
    ...(bufferDuration == null ? {} : { buffer: { duration: bufferDuration } }),
    get isPlaying() {
      return playing
    },
    play,
    stop,
    type: 'Audio',
  } as unknown as import('three').Audio

  return { audio, play, stop }
}

/** An MMD whose single PMX bone is an IK definition, so the property track can drive it. */
const createIkMmd = (ikName = 'ik') => {
  const ikBone = new Bone()
  ikBone.name = ikName
  const linkBone = new Bone()
  linkBone.name = 'link'
  const targetBone = new Bone()
  targetBone.name = 'target'
  linkBone.add(targetBone)

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial())
  mesh.add(ikBone, linkBone)
  mesh.bind(new Skeleton([ikBone, linkBone, targetBone]))

  const bone = (
    name: string,
    parentBoneIndex: number,
    position: [number, number, number],
    ik?: PmxObject['bones'][number]['ik'],
  ): PmxObject['bones'][number] => ({
    appendTransform: undefined,
    axisLimit: undefined,
    englishName: name,
    externalParentTransform: undefined,
    flag: ik === undefined ? 0 : PmxObject.Bone.Flag.IsIkEnabled,
    ik,
    localVector: undefined,
    name,
    parentBoneIndex,
    position,
    tailPosition: [0, 0, 0],
    transformOrder: 0,
  })

  const pmx: PmxObject = {
    bones: [
      bone(ikName, -1, [0, 0, 0], {
        iteration: 1,
        links: [{ limitation: undefined, target: 1 }],
        rotationConstraint: Math.PI,
        target: 2,
      }),
      bone('link', -1, [0, 0, 0]),
      bone('target', 1, [1, 0, 0]),
    ],
    displayFrames: [],
    header: {
      additionalVec4Count: 0,
      boneIndexSize: 4,
      comment: '',
      encoding: PmxObject.Header.Encoding.Utf8,
      englishComment: '',
      englishModelName: '',
      materialIndexSize: 4,
      modelName: 'ik',
      morphIndexSize: 4,
      rigidBodyIndexSize: 4,
      signature: 'PMX',
      textureIndexSize: 4,
      version: 2,
      vertexIndexSize: 4,
    },
    indices: new Uint8Array(),
    joints: [],
    materials: [],
    morphs: [],
    rigidBodies: [],
    softBodies: [],
    textures: [],
    vertices: [],
  }

  return new MMD(pmx, mesh)
}

/**
 * Builds a synthetic VMD with bone keys on the IK chain and IK property keys,
 * so the clip carries both the skeletal tracks and the property track.
 *
 * The bone keys span `boneDuration` seconds and the property keys are given in
 * VMD frames, which is also the unit the manager must scale.
 */
const createPropertyAnimation = (
  propertyKeyFrames: { frameNumber: number, ikStates: [string, boolean][] }[],
  boneFrames = [0, 60],
) => {
  const boneKeyFrames = boneFrames.map(frameNumber => ({
    boneName: 'link',
    frameNumber,
    interpolation: new Uint8Array(64).fill(20),
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
  }))

  const vmd = {
    boneKeyFrames: {
      get: (index: number) => boneKeyFrames[index],
      length: boneKeyFrames.length,
    },
    cameraKeyFrames: { get: () => undefined, length: 0 },
    morphKeyFrames: { get: () => undefined, length: 0 },
    propertyKeyFrames: propertyKeyFrames.map(frame => ({ ...frame, visible: true })),
  } as unknown as import('babylon-mmd/esm/Loader/Parser/vmdObject').VmdObject

  const mmd = createIkMmd()
  return { animation: buildAnimation(vmd, mmd.mesh), mmd }
}

describe('mMDAnimationManager', () => {
  it('advances every registered MMD through its mixer and MMD update', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const firstPhysicsUpdate = vi.fn()
    const secondPhysicsUpdate = vi.fn()
    const firstPhysics = {
      createHelper: <T>() => undefined as T,
      update: firstPhysicsUpdate,
    }
    const secondPhysics = {
      createHelper: <T>() => undefined as T,
      update: secondPhysicsUpdate,
    }
    first.setPhysics(() => firstPhysics)
    second.setPhysics(() => secondPhysics)
    const manager = new MMDAnimationManager()

    manager.add(first, { animation: createClip('first animation') })
    manager.add(second, { animation: createClip('second animation') })
    manager.update(0.25)

    expect(first.mesh.position.x).toBeCloseTo(0.25)
    expect(second.mesh.position.x).toBeCloseTo(0.25)
    expect(firstPhysicsUpdate).toHaveBeenCalledOnce()
    expect(firstPhysicsUpdate).toHaveBeenCalledWith(0.25)
    expect(secondPhysicsUpdate).toHaveBeenCalledOnce()
    expect(secondPhysicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('resets physics when a skeletal animation loops', () => {
    const mmd = createMmd('physics-loop')
    const events: string[] = []
    const resetPositions: number[] = []
    const physics = {
      createHelper: <T>() => undefined as T,
      reset: () => {
        resetPositions.push(mmd.mesh.skeleton.bones[0].position.x)
        events.push('reset')
      },
      update: () => events.push('update'),
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, {
      animation: new AnimationClip('skeletal animation', 1, [
        new VectorKeyframeTrack('.bones[0].position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })
    manager.update(2.1)

    expect(events).toEqual(['reset', 'update'])
    expect(resetPositions[0]).toBeCloseTo(0.1)

    manager.update(2.1, { physics: false })
    expect(events).toEqual(['reset', 'update', 'reset'])
  })

  it('passes MMD update options to every registered model', () => {
    const mmd = createMmd('options')
    const physicsUpdate = vi.fn()
    const physics = {
      createHelper: <T>() => undefined as T,
      update: physicsUpdate,
    }
    mmd.setPhysics(() => physics)
    const manager = new MMDAnimationManager()

    manager.add(mmd)
    manager.update(0.25, { physics: false })
    expect(physicsUpdate).not.toHaveBeenCalled()

    manager.update(0.25)
    expect(physicsUpdate).toHaveBeenCalledOnce()
    expect(physicsUpdate).toHaveBeenCalledWith(0.25)
  })

  it('syncs registered animation clips to the configured duration without changing the source clip', () => {
    const mmd = createMmd('duration')
    const animation = createClip('duration animation')
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(mmd, { animation })
    manager.update(1.5)
    expect(mmd.mesh.position.x).toBeCloseTo(1)
    expect(animation.duration).toBe(1)

    manager.update(0.5)
    expect(mmd.mesh.position.x).toBeCloseTo(0)
  })

  it('updates the registered MMD camera and its target after animation', () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100)
    const manager = new MMDAnimationManager()

    manager.add(camera, { animation: createCameraClip() })
    manager.update(0.5)

    expect(camera.fov).toBe(45)
    expect(camera.children).toHaveLength(1)
    expect(camera.children[0]).toMatchObject({ name: 'target' })
    expect(camera.children[0].position.toArray()).toEqual([0.5, 1, -2])
    const direction = camera.getWorldDirection(new Vector3())
    expect(direction.x).toBeCloseTo(0.21821789, 6)
    expect(direction.y).toBeCloseTo(0.43643578, 6)
    expect(direction.z).toBeCloseTo(-0.87287156, 6)
  })

  it('does not update or attach a target to a camera without animation', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(1, 2, 3)
    camera.rotation.set(0.1, 0.2, 0.3)
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()
    const manager = new MMDAnimationManager()

    manager.add(camera)
    manager.update(1)

    expect(camera.position.equals(position)).toBe(true)
    expect(camera.quaternion.equals(quaternion)).toBe(true)
    expect(camera.children).toHaveLength(0)

    manager.remove(camera)
    expect(() => manager.add(new PerspectiveCamera())).not.toThrow()
  })

  it('starts delayed audio once and stops audio it started when removed', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager()

    manager.add(audio, { delayTime: 1 })
    manager.update(0.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.5)
    manager.update(1)
    expect(play).toHaveBeenCalledOnce()

    manager.remove(audio)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('restarts audio after each configured duration and delay', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()

    manager.update(1.5)
    expect(stop).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledOnce()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('does not start audio in the trailing silence of a global loop', () => {
    let playing = false
    const play = vi.fn(() => {
      playing = true
    })
    const stop = vi.fn(() => {
      playing = false
    })
    const audio = {
      buffer: { duration: 3 },
      get isPlaying() {
        return playing
      },
      play,
      stop,
      type: 'Audio',
    } as unknown as import('three').Audio
    const manager = new MMDAnimationManager({ duration: 10 })

    manager.add(audio, { delayTime: 2 })
    manager.update(6)
    expect(play).not.toHaveBeenCalled()

    manager.update(10)
    expect(play).not.toHaveBeenCalled()

    manager.update(6)
    expect(play).toHaveBeenCalledOnce()
  })

  it('returns IK control to the loop start when a property track wraps', () => {
    // The only IK key sits at frame 15: for the first half of every loop the
    // bone must be back at its pre-animation state, not the previous loop's.
    const { animation, mmd } = createPropertyAnimation([
      { frameNumber: 15, ikStates: [['ik', false]] },
    ])
    const manager = new MMDAnimationManager()

    manager.add(mmd, { animation })
    manager.update(0.6, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)

    // Cross the end of the 2s clip: the loop restarts before its first IK key.
    manager.update(1.5, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)

    // And the key applies again in the new loop.
    manager.update(0.5, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
  })

  it('removes one model without affecting other registered objects', () => {
    const first = createMmd('first')
    const second = createMmd('second')
    const camera = new PerspectiveCamera()
    const manager = new MMDAnimationManager()

    manager.add(first)
    manager.add(second, { animation: createClip('second animation') })
    manager.add(camera)
    manager.remove(first)
    second.mesh.position.x = 0
    manager.update(0.25)

    expect(first.mesh.position.x).toBe(0)
    expect(second.mesh.position.x).toBeCloseTo(0.25)

    manager.dispose()
    expect(camera.children).toHaveLength(0)
  })

  it('scales the IK property track with the global duration', () => {
    // Bone keys span 0..60 frames (2s); the IK switch is at frame 30, halfway.
    const { animation, mmd } = createPropertyAnimation([
      { frameNumber: 0, ikStates: [['ik', true]] },
      { frameNumber: 30, ikStates: [['ik', false]] },
    ])
    const originalFrames = [
      ...(animation.userData as { propertyTrack: { frameNumbers: number[] } }).propertyTrack.frameNumbers,
    ]
    const manager = new MMDAnimationManager({ duration: 4 })

    manager.add(mmd, { animation })
    manager.update(0, { grant: false, physics: false })

    // The source clip is untouched, the manager-owned copy is retimed.
    expect((animation.userData as { propertyTrack: { frameNumbers: number[] } }).propertyTrack.frameNumbers)
      .toEqual(originalFrames)

    // Frame 30 of the 2s clip sits halfway through it, i.e. at 2s of the 4s loop.
    manager.update(1.5, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)

    manager.update(0.5, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
  })

  it('scales an IK-only property track even when it defines the clip end', () => {
    const { animation, mmd } = createPropertyAnimation(
      [
        { frameNumber: 0, ikStates: [['ik', true]] },
        { frameNumber: 60, ikStates: [['ik', false]] },
      ],
      [],
    )
    // With no bone keys the property track alone defines the source length:
    // (60 + 1) / 30 seconds.
    expect(animation.duration).toBeCloseTo(61 / 30)
    const manager = new MMDAnimationManager({ duration: 10 })

    manager.add(mmd, { animation })
    manager.update(2, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(true)

    // The switch scales to frame 60 * 10 / (61 / 30) ~= 295, i.e. ~9.84s.
    manager.update(7.9, { grant: false, physics: false })
    expect(mmd.ikSolver.isEnabled(0)).toBe(false)
  })

  it('does not leak the previous loop camera orientation across the boundary', () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100)
    // Only target and fov are animated: the camera's own position/rotation stay
    // untouched by the clip and must still be reset when the loop wraps.
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(camera, { animation: createCameraClip() })
    manager.update(1.5)
    const firstLoopQuaternion = camera.quaternion.clone()

    manager.update(0.75)
    const secondLoopQuaternion = camera.quaternion.clone()

    // 0.25 into the loop vs 1.5: different frames, but computed from the rest
    // pose instead of from the stale end-of-loop orientation.
    const fresh = new PerspectiveCamera(30, 1, 0.1, 100)
    const freshManager = new MMDAnimationManager({ duration: 2 })
    freshManager.add(fresh, { animation: createCameraClip() })
    freshManager.update(0.25)

    // The roll (the implicit up vector) is the part the clip does not animate.
    expect(secondLoopQuaternion.angleTo(fresh.quaternion)).toBeLessThan(1e-9)
    expect(camera.up.distanceTo(fresh.up)).toBeLessThan(1e-9)
    expect(camera.up.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9)
    expect(secondLoopQuaternion.angleTo(firstLoopQuaternion)).toBeGreaterThan(1e-3)
  })

  it('keeps the animated camera position when the loop wraps', () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100)
    const clip = new AnimationClip('camera animation', 2, [
      new VectorKeyframeTrack('target.position', [0, 2], [0, 0, -1, 2, 0, -2]),
      new VectorKeyframeTrack('.position', [0, 2], [1, 2, 3, 4, 5, 6]),
      new QuaternionKeyframeTrack('.quaternion', [0, 2], [0, 0, 0, 1, 0.2, 0.3, 0.4, 0.5]),
    ])
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(camera, { animation: clip })
    manager.update(1.5)
    manager.update(1)

    const fresh = new PerspectiveCamera(30, 1, 0.1, 100)
    const freshManager = new MMDAnimationManager({ duration: 2 })
    freshManager.add(fresh, { animation: clip })
    freshManager.update(0.5)

    expect(camera.position.distanceTo(fresh.position)).toBeLessThan(1e-9)
    expect(camera.quaternion.angleTo(fresh.quaternion)).toBeLessThan(1e-9)
    expect(camera.children[0].position.distanceTo(fresh.children[0].position)).toBeLessThan(1e-9)
  })

  it('starts audio once per loop with duration and delay', () => {
    const { audio, play } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime: 0.5 })

    manager.update(0.25)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(1)

    // Still the same loop: the delay window must not restart the audio.
    manager.update(0.8)
    expect(play).toHaveBeenCalledTimes(1)

    // Cross into the next loop but stay before its delay.
    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(1)

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['at the loop start', 0],
    ['near the loop end', 1.9],
  ])('starts audio exactly once per loop with a delay %s', (_, delayTime) => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    manager.add(audio, { delayTime })
    manager.update(1.95)
    expect(play).toHaveBeenCalledTimes(1)

    // Reaching the loop boundary wraps once and starts the new loop once.
    manager.update(1.95)
    expect(play).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(1)

    // A frame that consumes several loops still starts only the loop it lands
    // in, never once per skipped loop.
    manager.update(6)
    expect(play).toHaveBeenCalledTimes(3)
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('starts audio once per loop when the delay is not shorter than the loop', () => {
    const { audio, play } = createAudio()
    const manager = new MMDAnimationManager({ duration: 2 })

    // A 3s delay can never be reached inside a 2s loop, so the delay is folded
    // into the loop (3 % 2 = 1): each loop starts the audio 1s in, once.
    manager.add(audio, { delayTime: 3 })

    manager.update(0.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.75)
    expect(play).toHaveBeenCalledTimes(1)

    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(1)

    // Cross the boundary, then reach the folded delay inside the next loop.
    manager.update(0.5)
    expect(play).toHaveBeenCalledTimes(1)

    manager.update(1)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('does not start audio in the trailing silence of a loop', () => {
    const { audio, play } = createAudio(1)
    const manager = new MMDAnimationManager({ duration: 3 })

    manager.add(audio, { delayTime: 1 })

    // Delay 1 + buffer 1 closes the window at 2s; a frame that lands past it
    // must not start the audio late.
    manager.update(2.5)
    expect(play).not.toHaveBeenCalled()

    manager.update(0.2)
    expect(play).not.toHaveBeenCalled()

    // The next loop reaches the window again and starts exactly once.
    manager.update(1.6)
    expect(play).toHaveBeenCalledOnce()

    // Staying inside the same loop does not restart the audio.
    manager.update(0.5)
    expect(play).toHaveBeenCalledOnce()
  })

  it('stops manager-started audio when disposed', () => {
    const { audio, play, stop } = createAudio()
    const manager = new MMDAnimationManager()

    manager.add(audio, { delayTime: 0 })
    manager.update(0.1)
    expect(play).toHaveBeenCalledOnce()

    manager.dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('removes a model and restores its IK while other models keep advancing', () => {
    const removed = createIkMmd()
    const kept = createIkMmd()
    const removedPhysicsUpdate = vi.fn()
    const keptPhysicsUpdate = vi.fn()
    removed.setPhysics(() => ({ createHelper: <T>() => undefined as T, update: removedPhysicsUpdate }))
    kept.setPhysics(() => ({ createHelper: <T>() => undefined as T, update: keptPhysicsUpdate }))

    const propertyClip = new AnimationClip('property', 1, [])
    propertyClip.userData = {
      propertyTrack: {
        frameNumbers: [0],
        ikBoneNames: ['ik'],
        ikStates: [[false]],
      },
    }
    const manager = new MMDAnimationManager()

    manager.add(removed, { animation: propertyClip })
    manager.add(kept, {
      animation: new AnimationClip('kept animation', 1, [
        new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 1, 0, 0]),
      ]),
    })
    manager.update(0, { grant: false, physics: false })
    expect(removed.ikSolver.isEnabled(0)).toBe(false)
    expect(kept.ikSolver.isEnabled(0)).toBe(true)

    manager.remove(removed)

    expect(removed.ikSolver.isEnabled(0)).toBe(true)
    expect(kept.mesh.position.x).toBeCloseTo(0)

    kept.mesh.position.x = 0
    manager.update(0.25)
    expect(kept.mesh.position.x).toBeCloseTo(0.25)
    expect(keptPhysicsUpdate).toHaveBeenCalledOnce()
    expect(removedPhysicsUpdate).not.toHaveBeenCalled()
  })
})
