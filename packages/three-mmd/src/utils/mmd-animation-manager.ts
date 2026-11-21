import type { AnimationClip, Audio, Camera, Quaternion, Vector3 } from 'three'

import type { MMDUpdateOptions } from './mmd'

import { AnimationMixer, Object3D } from 'three'

import { retimeAnimationClip } from './build-animation'
import { MMD } from './mmd'

export interface AudioAnimationOptions {
  delayTime?: number
}

export interface MMDAnimationOptions {
  animation?: AnimationClip | AnimationClip[]
}

const playAnimation = (
  mixer: AnimationMixer,
  animation?: AnimationClip | AnimationClip[],
  duration?: number,
): AnimationClip[] => {
  if (animation == null)
    return []

  const animations = (Array.isArray(animation) ? animation : [animation]) as readonly AnimationClip[]
  return animations.map((source) => {
    const clip = duration == null
      ? source
      : retimeAnimationClip(source, duration)

    mixer.clipAction(clip).play()
    return clip
  })
}

/**
 * Root-space properties of the camera that a clip animates.
 *
 * Track names are relative to the camera (e.g. `.position`), while child nodes
 * (such as `target.position`) name the node before the dot and therefore do
 * not animate the camera root.
 */
const getAnimatedRootProperties = (clips: readonly AnimationClip[]): Set<string> => {
  const properties = new Set<string>()
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (!track.name.startsWith('.'))
        continue

      const property = track.name.slice(1)
      const dot = property.indexOf('.')
      properties.add(dot === -1 ? property : property.slice(0, dot))
    }
  }

  return properties
}

interface CameraPose {
  fov?: number
  position: Vector3
  quaternion: Quaternion
}

/** Coordinates MMD, camera, and audio animation on a single render-loop update. */
export class MMDAnimationManager {
  private audio?: Audio
  private audioDelay = 0
  private audioDuration?: number

  private audioElapsed = 0
  private audioStarted = false
  private audioStartedByManager = false

  private camera?: Camera
  private cameraAnimatedProperties?: ReadonlySet<string>
  private cameraMixer?: AnimationMixer
  private cameraRestPose?: CameraPose
  private cameraTarget?: Object3D
  private readonly duration?: number
  private readonly models = new Map<MMD, AnimationMixer>()

  public constructor(options: { duration?: number } = {}) {
    if (options.duration != null && (!Number.isFinite(options.duration) || options.duration <= 0))
      throw new RangeError('MMDAnimationManager: duration must be a positive finite number.')

    this.duration = options.duration
  }

  public add(mmd: MMD, options?: MMDAnimationOptions): this
  public add(camera: Camera, options?: MMDAnimationOptions): this
  public add(audio: Audio, options?: AudioAnimationOptions): this
  public add(
    object: Audio | Camera | MMD,
    options: AudioAnimationOptions | MMDAnimationOptions = {},
  ): this {
    if (object instanceof MMD) {
      if (this.models.has(object))
        throw new Error('MMDAnimationManager: MMD has already been added.')

      const mmdOptions = options as MMDAnimationOptions
      const mixer = new AnimationMixer(object.mesh)
      const { animation } = mmdOptions

      this.models.set(object, mixer)
      playAnimation(mixer, animation, this.duration)
      return this
    }
    else if ('isCamera' in object) {
      if (this.camera !== undefined)
        throw new Error('MMDAnimationManager: Camera has already been added.')

      const cameraOptions = options as MMDAnimationOptions
      this.camera = object

      if (cameraOptions.animation != null) {
        const target = new Object3D()
        target.name = 'target'

        object.add(target)
        this.cameraTarget = target
        this.cameraMixer = new AnimationMixer(object)
        this.cameraAnimatedProperties = getAnimatedRootProperties(
          playAnimation(this.cameraMixer, cameraOptions.animation, this.duration),
        )
        this.cameraRestPose = {
          fov: (object as Camera & { fov?: number }).fov,
          position: object.position.clone(),
          quaternion: object.quaternion.clone(),
        }
      }

      return this
    }
    else if (object.type === 'Audio') {
      if (this.audio !== undefined)
        throw new Error('MMDAnimationManager: Audio has already been added.')

      const audioOptions = options as AudioAnimationOptions
      this.audio = object
      this.audioDelay = audioOptions.delayTime ?? 0
      this.audioDuration = object.buffer?.duration
      this.audioElapsed = 0
      this.audioStarted = object.isPlaying
      this.audioStartedByManager = false
      return this
    }
    else {
      throw new TypeError('MMDAnimationManager.add: expected an MMD, Camera, or Audio.')
    }
  }

  public dispose() {
    // Snapshot the keys: remove() mutates the map while it is iterated.
    for (const mmd of [...this.models.keys()])
      this.remove(mmd)

    if (this.camera !== undefined)
      this.remove(this.camera)

    if (this.audio !== undefined)
      this.remove(this.audio)
  }

  public remove(object: Audio | Camera | MMD): this {
    if (object instanceof MMD) {
      const mixer = this.models.get(object)
      if (mixer == null)
        return this

      mixer.stopAllAction()
      object.updateAnimation()
      mixer.uncacheRoot(object.mesh)
      this.models.delete(object)
      return this
    }
    else if ('isCamera' in object) {
      if (this.camera !== object)
        return this

      if (this.cameraMixer != null) {
        this.cameraMixer.stopAllAction()
        this.cameraMixer.uncacheRoot(object)
      }
      if (this.cameraTarget?.parent === object)
        object.remove(this.cameraTarget)

      this.camera = undefined
      this.cameraAnimatedProperties = undefined
      this.cameraMixer = undefined
      this.cameraRestPose = undefined
      this.cameraTarget = undefined
      return this
    }
    else if (object.type === 'Audio') {
      if (this.audio !== object)
        return this

      if (this.audioStartedByManager && object.isPlaying)
        object.stop()

      this.audio = undefined
      this.audioDelay = 0
      this.audioDuration = undefined
      this.audioElapsed = 0
      this.audioStarted = false
      this.audioStartedByManager = false
      return this
    }
    else {
      throw new Error('MMDAnimationManager.remove: expected an MMD, Camera, or Audio.')
    }
  }

  public update(delta: number, options?: MMDUpdateOptions): this {
    this.updateAudio(delta)

    for (const [mmd, mixer] of this.models)
      this.updateMMD(mmd, mixer, delta, options)

    if (this.camera != null && this.cameraMixer != null && this.cameraTarget != null) {
      let cameraLooped = false
      const onLoop = () => {
        cameraLooped = true
      }

      this.cameraMixer.addEventListener('loop', onLoop)
      try {
        this.cameraMixer.update(delta)
      }
      finally {
        this.cameraMixer.removeEventListener('loop', onLoop)
      }

      // A looping camera clip only rewinds the properties it animates. Under a
      // global loop, reset the rest to their rest pose so the previous round
      // cannot leak into the next one.
      if (cameraLooped && this.duration != null)
        this.resetCamera()

      const camera = this.camera as Camera & { updateProjectionMatrix?: () => void }
      camera.updateProjectionMatrix?.()
      this.camera.up.set(0, 1, 0)
      this.camera.up.applyQuaternion(this.camera.quaternion)
      this.camera.lookAt(this.cameraTarget.position)
    }

    return this
  }

  private resetCamera() {
    const camera = this.camera
    const restPose = this.cameraRestPose
    if (camera == null || restPose == null)
      return

    const animated = this.cameraAnimatedProperties
    if (animated?.has('position') !== true)
      camera.position.copy(restPose.position)
    if (animated?.has('quaternion') !== true)
      camera.quaternion.copy(restPose.quaternion)

    const fovCamera = camera as Camera & { fov?: number }
    if (animated?.has('fov') !== true && restPose.fov != null)
      fovCamera.fov = restPose.fov
  }

  private startAudio() {
    this.audioStarted = true

    const audio = this.audio
    if (audio == null || audio.isPlaying)
      return

    audio.play()
    this.audioStartedByManager = true
  }

  private updateAudio(delta: number) {
    const audio = this.audio
    if (audio == null)
      return

    const elapsed = Math.max(delta, 0)
    const audioDuration = this.audioDuration

    // Without a global duration the audio runs on its own timeline.
    if (this.duration == null) {
      this.audioElapsed += elapsed
      if (!this.audioStarted
        && this.audioElapsed >= this.audioDelay
        && (audioDuration == null || this.audioElapsed <= this.audioDelay + audioDuration)) {
        this.startAudio()
      }
      return
    }

    const duration = this.duration

    // The delay is an offset inside the loop. Folding it into the loop keeps a
    // delay that is not shorter than the loop from pushing the start position
    // past the end, where it could never be reached and the audio of every loop
    // would be silently skipped.
    const delay = this.audioDelay % duration
    const windowEnd = audioDuration == null ? Number.POSITIVE_INFINITY : delay + audioDuration
    const next = this.audioElapsed + elapsed
    const loops = Math.floor(next / duration)

    // Wrap before sampling. A frame that ends on or past a loop boundary
    // belongs to the new loop: whatever the previous loop was playing is
    // stopped, and only the loop the frame lands in may start the audio. That
    // is at most one start per frame, however many loops the frame consumes.
    if (loops > 0)
      this.wrapAudioLoop()

    this.audioElapsed = next - loops * duration

    // Judge by the landing position, so a frame that runs past the delay window
    // (a trailing silence) does not start audio that would be out of place.
    if (!this.audioStarted && this.audioElapsed >= delay && this.audioElapsed <= windowEnd)
      this.startAudio()
  }

  private updateMMD(
    mmd: MMD,
    mixer: AnimationMixer,
    delta: number,
    options?: MMDUpdateOptions,
  ) {
    let skeletalAnimationLooped = false
    const onLoop = (event: { action: { getClip: () => AnimationClip } }) => {
      if (!event.action.getClip().tracks.some(track => track.name.startsWith('.bones')))
        return

      skeletalAnimationLooped = true
    }

    mmd.beforeUpdate()
    mixer.addEventListener('loop', onLoop)
    try {
      mixer.update(delta)
    }
    finally {
      mixer.removeEventListener('loop', onLoop)
    }

    mmd.updateAnimation(mixer)
    mmd.beforePhysics(options)

    if (skeletalAnimationLooped)
      mmd.physics?.reset?.()

    if (options?.physics !== false)
      mmd.physics?.update(delta)
    mmd.afterPhysics(options)
  }

  /** Rewinds the audio timeline when the global loop wraps. */
  private wrapAudioLoop() {
    const audio = this.audio
    if (audio?.isPlaying === true)
      audio.stop()

    this.audioElapsed = 0
    this.audioStarted = false
  }
}
