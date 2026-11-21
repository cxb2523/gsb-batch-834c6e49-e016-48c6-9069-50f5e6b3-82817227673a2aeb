import { getEventOffsetX, toggleClass } from '../utils/dom';
import { off, on } from '../utils/events';
import is from '../utils/is';

class ProgressBar {
  constructor(player) {
    this.player = player;
    this.positionX = 0;
    this.timer = null;
    this.restoreAnimationTimer = null;
    this.resizeTimer = null;
    this.initiallyPaused = false;
    this.playPauseAnimation = null;
    // Whether a document-level drag (mousedown/touchstart) is in progress
    this.scrubbing = false;
    // Set only when this module paused the media, so resume is always paired
    this.pausedByScrub = false;

    this.listeners();
  }

  update = (seeking = false) => {
    const { player } = this;
    const { progressContainer, playProgress, scrubberProgressContainer } = player.controls;
    const width = progressContainer.clientWidth;
    const duration = player.duration;

    if (seeking && width > 0 && duration > 0) {
      this.positionX = Math.max(Math.min(this.positionX, width), 0);
      player.currentTime = (duration * this.positionX) / width;
    }

    const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const scaleX = duration > 0 ? Math.min(Math.max(currentTime / duration, 0), 1) : 0;
    const translateX = scaleX * width;

    playProgress.style.transform = `scaleX(${scaleX})`;
    scrubberProgressContainer.style.transform = `translateX(${translateX}px)`;
    progressContainer.setAttribute('aria-valuemax', String(Math.round(duration)));
    progressContainer.setAttribute('aria-valuenow', String(Math.round(currentTime)));
    progressContainer.setAttribute('aria-valuetext', player.config.captions.seconds(Math.round(currentTime)));
  };

  start = (event) => {
    const { player } = this;

    // Ignore repeated starts until the previous drag ends
    if (this.scrubbing) {
      return;
    }

    this.scrubbing = true;

    // hide animations
    if (this.playPauseAnimation === null) {
      this.playPauseAnimation = player.config.layoutControls.playPauseAnimation;
      player.config.layoutControls.playPauseAnimation = false;
    }

    this.positionX = getEventOffsetX(player.controls.progressContainer, event);

    this.initiallyPaused = player.paused;
    this.pausedByScrub = false;
    if (!this.initiallyPaused) {
      this.timer = setTimeout(() => {
        if (!this.scrubbing || this.pausedByScrub) {
          return;
        }

        this.pausedByScrub = true;
        player.pause();
      }, 300);
    }

    player.preview?.current?.scrubStart?.();

    on.call(player, document, 'mousemove touchmove', this.move);
    on.call(player, document, 'mouseup touchend mouseleave', this.end);
  };

  move = (event) => {
    const { player } = this;
    const { progressContainer, scrubberProgress } = player.controls;

    toggleClass(player.wrapper, 'fluid_seeking', true);

    player.preview?.current?.move?.(event);

    this.positionX = getEventOffsetX(progressContainer, event);

    this.update(true);

    // resize
    scrubberProgress.style.setProperty('transform', 'none', 'important');

    if (player.touch) {
      return;
    }

    for (const node of progressContainer.childNodes) {
      if (node.className.includes('scrubber')) {
        continue;
      }
      node.style.transform = 'none';
    }
  };

  end = (event) => {
    const { player } = this;
    const { progressContainer, scrubberProgress } = player.controls;

    // A single drag must end exactly once even if several end events fire
    if (!this.scrubbing) {
      return;
    }

    this.scrubbing = false;

    toggleClass(player.wrapper, 'fluid_seeking', false);

    player.preview?.current?.scrubEnd?.();

    // back to normal size
    for (const node of progressContainer.childNodes) {
      node.style.removeProperty('transform');
    }

    scrubberProgress.style.removeProperty('transform');

    const positionX = getEventOffsetX(progressContainer, event);
    if (is.number(positionX)) {
      this.positionX = positionX;
    }

    this.update(true);

    // Resume only when this drag paused the media (or its pause is still
    // pending), keeping every pause/resume pair balanced
    if (!this.initiallyPaused) {
      clearTimeout(this.timer);
      this.timer = null;

      if (this.pausedByScrub || !player.paused) {
        player.play();
      }

      this.pausedByScrub = false;
      player.controlBar.toggleMobile(false);
    }

    // restore animations
    this.restoreAnimationTimer = setTimeout(() => {
      this.restorePlayPauseAnimation();
    }, 200);

    off.call(player, document, 'mousemove touchmove', this.move);
    off.call(player, document, 'mouseup touchend mouseleave', this.end);
  };

  // Tear down an in-progress drag without resuming playback. Used when the
  // media source changes, the source list is cleared or the player is destroyed.
  cancelScrub = () => {
    if (!this.scrubbing && this.timer === null && this.restoreAnimationTimer === null) {
      return;
    }

    this.scrubbing = false;

    clearTimeout(this.timer);
    this.timer = null;
    this.pausedByScrub = false;

    off.call(this.player, document, 'mousemove touchmove', this.move);
    off.call(this.player, document, 'mouseup touchend mouseleave', this.end);

    this.restorePlayPauseAnimation();
  };

  restorePlayPauseAnimation = () => {
    clearTimeout(this.restoreAnimationTimer);
    this.restoreAnimationTimer = null;

    if (this.playPauseAnimation === null) {
      return;
    }

    this.player.config.layoutControls.playPauseAnimation = this.playPauseAnimation;
    this.playPauseAnimation = null;
  };

  hover = (event) => {
    const { progressContainer, hoverProgress } = this.player.controls;
    const width = progressContainer.clientWidth;
    const positionX = getEventOffsetX(progressContainer, event);
    const scaleX = width > 0 && Number.isFinite(positionX) ? Math.min(Math.max(positionX / width, 0), 1) : 0;

    hoverProgress.style.transform = `scaleX(${scaleX})`;
  };

  keydown = (event) => {
    let time = this.player.currentTime;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        time += 5;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        time -= 5;
        break;
      case 'Home':
        time = 0;
        break;
      case 'End':
        time = this.player.duration;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.player.currentTime = Math.min(Math.max(time, 0), this.player.duration);
    this.update();
  };

  listeners = () => {
    const { player } = this;
    const { progressContainer } = player.controls;

    on.call(player, progressContainer, 'mousedown touchstart', this.start);
    on.call(player, progressContainer, 'mousemove', this.hover);
    on.call(player, progressContainer, 'keydown', this.keydown, false);
  };

  resize = () => {
    this.resizeTimer = setTimeout(() => {
      this.update();
    }, 100);
  };

  destroy = () => {
    this.cancelScrub();
    clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
  };
}

export default ProgressBar;
