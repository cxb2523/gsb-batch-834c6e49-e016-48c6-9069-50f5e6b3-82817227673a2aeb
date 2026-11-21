import { createElement, findPosition, getEventOffsetX } from '../utils/dom';
import { on } from '../utils/events';
import { WebVTT } from 'videojs-vtt.js';
import { formatTime } from '../utils/time';
import computedStyle from '../utils/computed-style';
import fetch from '../utils/fetch';
import is from '../utils/is';
import { addVttCue, MAX_VTT_BYTES } from '../utils/vtt';

class PreviewThumbnails {
  constructor(player) {
    this.player = player;
    // Thumbnail data is bound to the media source that requested it
    this.sourceKey = null;
    this.loaded = false;
    this.data = [];
    this.request = null;
    this.generation = 0;
    // Per-source cache: the same source reuses its parsed VTT within its lifetime
    this.cache = new Map();
    // Image URLs confirmed (or known not) to be available for the current source
    this.imageStates = new Map();
    // Static frames are provided through config instead of a per-source VTT
    this.staticMode = false;
    this.destroyed = false;
    // State of an in-progress drag / hover so late data can be rendered safely
    this.pointerActive = false;
    this.pendingEvent = null;
  }

  get sourceKeyOfPlayer() {
    const { src } = this.player.currentSource || {};
    return is.string(src) && !is.empty(src) ? this.normalizeKey(src) : null;
  }

  // Canonicalize the key so relative and absolute references to the same media
  // source are treated identically regardless of how the source was supplied
  normalizeKey = (key) => {
    if (!is.string(key) || is.empty(key)) {
      return '';
    }

    try {
      return new URL(key, document.baseURI).href;
    } catch (_) {
      return key;
    }
  };

  init = () => {
    const option = this.player.config.layoutControls.timelinePreview;

    if (option.type === 'VTT' && is.string(option.file) && !is.empty(option.file)) {
      // The shell (with the time tooltip) is rendered up front so that dragging
      // while the VTT is still loading can show the time text without an image.
      this.renderShell();
      // A player may initialize without a media source: use an empty bootstrap
      // key so the VTT still loads immediately and gets adopted by the first
      // real source instead of being requested twice.
      this.bindSource(this.sourceKeyOfPlayer || '');
      return Promise.resolve();
    }

    if (option.type === 'static' && is.array(option.frames)) {
      this.staticMode = true;
      this.data = option.frames;
      option.spriteImage = true;
      this.renderShell();
      this.loaded = true;
    }

    return Promise.resolve();
  };

  parseVtt = (vttRawData) => {
    if (!vttRawData.length) {
      return [];
    }

    const result = [];
    let tempThumbnailData = null;
    let tempThumbnailCoordinates = null;

    for (const vtt of vttRawData) {
      tempThumbnailData = vtt.text.split('#');
      let xCoords = 0;
      let yCoords = 0;
      let wCoords = 122.5;
      let hCoords = 69;

      // .vtt file contains sprite corrdinates
      if (tempThumbnailData.length === 2 && tempThumbnailData[1].indexOf('xywh=') === 0) {
        tempThumbnailCoordinates = tempThumbnailData[1].substring(5);
        tempThumbnailCoordinates = tempThumbnailCoordinates.split(',');

        if (tempThumbnailCoordinates.length === 4) {
          this.player.config.layoutControls.timelinePreview.spriteImage = true;
          xCoords = parseInt(tempThumbnailCoordinates[0]);
          yCoords = parseInt(tempThumbnailCoordinates[1]);
          wCoords = parseInt(tempThumbnailCoordinates[2]);
          hCoords = parseInt(tempThumbnailCoordinates[3]);
        }
      }

      const thumbnail = this.player.config.layoutControls.timelinePreview;
      let imageUrl = thumbnail.sprite ? thumbnail.sprite : tempThumbnailData[0];
      if (thumbnail.spriteRelativePath && thumbnail.file.indexOf('/') !== -1) {
        imageUrl = thumbnail.file.substring(0, thumbnail.file.lastIndexOf('/') + 1) + tempThumbnailData[0];
      }

      result.push({
        startTime: vtt.startTime,
        endTime: vtt.endTime,
        image: imageUrl,
        x: xCoords,
        y: yCoords,
        w: wCoords,
        h: hCoords,
      });
    }

    return result;
  };

  // Bind thumbnail data to a media source. Switching sources invalidates the
  // previous source's cache, cancels its request and drops any late response.
  bindSource = (rawKey) => {
    if (this.destroyed || this.staticMode) {
      return;
    }

    const sourceKey = rawKey === null ? null : this.normalizeKey(rawKey);

    if (this.sourceKey === sourceKey) {
      return;
    }

    // Bootstrap: the VTT may already be loading (or loaded) before any media
    // source exists. The first real source adopts that data without dropping
    // the in-flight request or fetching the VTT again.
    if (this.sourceKey === '' && sourceKey !== null && sourceKey !== '') {
      this.adoptSource(sourceKey);
      return;
    }

    // An empty source list reported while still on the bootstrap key means no
    // concrete media source ever existed: keep the bootstrap request alive so
    // its data can be adopted by a source added later.
    if (sourceKey === null && this.sourceKey === '') {
      return;
    }

    this.generation += 1;
    this.request?.abort();
    this.request = null;

    this.sourceKey = sourceKey;
    this.loaded = false;
    this.data = [];
    this.cache.clear();
    this.imageStates.clear();
    this.resetView();

    // An empty source list has no media: do not fetch. The bootstrap empty
    // string key, however, represents "source not known yet" and must fetch.
    if (sourceKey === null) {
      return;
    }

    this.requestSource(this.generation);
  };

  // Re-key the bootstrap request / cached data under the first media source.
  // The in-flight bootstrap request is kept alive: aborting it would lose a
  // response that is still valid for the now-known source, so its result is
  // simply stored under the new key when it lands.
  adoptSource = (sourceKey) => {
    const bootstrapData = this.cache.get('');

    this.cache.delete('');
    this.sourceKey = sourceKey;

    if (bootstrapData) {
      this.cache.set(sourceKey, bootstrapData);
      this.data = bootstrapData;
      this.loaded = true;
      return;
    }

    // The bootstrap request is still in flight; its response is validated by
    // the generation and stored against the current source key when it lands.
    this.data = [];
    this.loaded = false;
  };

  requestSource = (generation) => {
    const { player } = this;
    const url = player.config.layoutControls.timelinePreview.file;
    const request = fetch(url, 'text', {
      timeout: player.config.xhrTimeout,
      maxBytes: MAX_VTT_BYTES,
      allowedOrigins: player.config.xhrAllowedOrigins,
      onBeforeOpen: player.config.onBeforeXMLHttpRequestOpen,
      onBeforeSend: player.config.onBeforeXMLHttpRequest,
    });

    this.request = request;

    request
      .then(
        (response) =>
          new Promise((resolve) => {
            const parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
            const cues = [];

            parser.oncue = (cue) => {
              addVttCue(cues, cue);
            };

            parser.onflush = () => {
              resolve(this.parseVtt(cues));
            };

            parser.parse(response);
            parser.flush();
          }),
      )
      .then((frames) => {
        // A late response from an older source must never reach the new media
        if (generation !== this.generation || this.destroyed) {
          return;
        }

        this.applyData(frames, this.sourceKey);
      })
      .catch((error) => {
        if (generation !== this.generation || this.destroyed) {
          return;
        }

        if (error?.name === 'AbortError') {
          return;
        }

        this.handleFailure(error);
      })
      .finally(() => {
        if (this.request === request) {
          this.request = null;
        }
      });
  };

  handleFailure = (error) => {
    this.player.debug.error(error);
    this.player.preview?.useTimeFallback?.();
  };

  applyData = (frames, sourceKey) => {
    if (this.destroyed || sourceKey !== this.sourceKey) {
      return;
    }

    this.data = Array.isArray(frames) ? frames : [];

    // Cache the parsed result for the current source only; it is discarded as
    // soon as another source (or an empty source list) becomes active
    if (!is.empty(this.data)) {
      this.cache.set(sourceKey, this.data);
    }

    this.loaded = true;

    if (is.empty(this.data)) {
      this.resetView();
      this.player.preview?.useTimeFallback?.();
      return;
    }

    // Data arrived during an ongoing drag / hover: render the matching frame
    // for the same interaction without waiting for a new pointer event.
    if (this.pointerActive && this.pendingEvent) {
      this.move(this.pendingEvent);
    }
  };

  move = (event) => {
    const { player } = this;

    if (this.destroyed || is.nullOrUndefined(this.preview)) {
      return;
    }

    const progress = player.controls.progressContainer;
    const width = progress.clientWidth;
    if (!width) {
      return;
    }

    this.pointerActive = true;
    this.pendingEvent = event;

    // get the hover position
    const offsetX = getEventOffsetX(progress, event);
    if (!Number.isFinite(offsetX) || offsetX < 0 || offsetX > width) {
      return;
    }

    const seconds = (player.duration * offsetX) / width;
    // get the thumbnail coordinates
    const size = this.getThumbSize(seconds);

    // No data yet: keep showing the time text only, never a blank/broken image
    if (!size) {
      this.showTimeOnly(seconds, offsetX, width);
      return;
    }

    this.whenImageReady(size.image, () => {
      if (this.destroyed || !this.pointerActive || this.pendingEvent !== event) {
        return;
      }

      // Re-check against the current position: the frame must match the time
      const latestOffset = getEventOffsetX(progress, this.pendingEvent);
      const latestSeconds = Number.isFinite(latestOffset) ? (player.duration * latestOffset) / width : seconds;
      const latestSize = this.getThumbSize(latestSeconds);

      if (latestSize) {
        this.renderFrame(latestSize, latestSeconds, Number.isFinite(latestOffset) ? latestOffset : offsetX, width);
      }
    });
  };

  whenImageReady = (imageUrl, callback) => {
    const state = this.imageStates.get(imageUrl);

    if (state === 'loaded') {
      callback();
      return;
    }

    if (state === 'error') {
      // The image cannot be displayed: fall back to the time text instead of
      // rendering a broken/empty image
      this.presentTimeOnly();
      return;
    }

    const generation = this.generation;
    const image = new Image();

    image.onload = () => {
      if (generation !== this.generation || this.destroyed) {
        return;
      }

      this.imageStates.set(imageUrl, 'loaded');
      callback();
    };

    image.onerror = () => {
      if (generation !== this.generation || this.destroyed) {
        return;
      }

      this.imageStates.set(imageUrl, 'error');
      this.presentTimeOnly();
    };

    image.src = imageUrl;
  };

  presentTimeOnly = () => {
    if (!this.pointerActive || !this.pendingEvent) {
      return;
    }

    const progress = this.player.controls.progressContainer;
    const width = progress.clientWidth;
    const offsetX = getEventOffsetX(progress, this.pendingEvent);
    const safeOffset = Number.isFinite(offsetX) ? offsetX : 0;
    const seconds = (this.player.duration * safeOffset) / (width || 1);
    this.showTimeOnly(seconds, safeOffset, width);
  };

  renderFrame = (size, seconds, offsetX, width) => {
    const { player } = this;
    const preview = this.preview;

    if (is.nullOrUndefined(preview)) {
      return;
    }
    // preview border is set to 2px, a total of 4px on both sides
    // and they are subtracted from the position of the timeline preview
    // so that it stays within the width of the timeline
    const borderLeft = parseInt(computedStyle(preview, 'border-left-width').replace('px', '')) * 2;
    const scrollLimit = Math.max(width - size.w - borderLeft, 0);
    // add the top position to the tooltip so it is not along with the preview
    const topTooltip = 7;
    // get the left position of the timeline
    const left = findPosition(player.controls.progressContainer, player.wrapper).left;

    const centeredOffset = offsetX - size.w / 2;
    let positionX = left;

    if (centeredOffset >= 0) {
      if (centeredOffset <= scrollLimit) {
        positionX = centeredOffset + left;
      } else {
        positionX = scrollLimit + left;
      }
    } else {
      positionX = left;
    }

    preview.classList.remove('fluid_timeline_preview_time_only');
    preview.style.background = `url(${size.image})`;
    preview.style.backgroundRepeat = 'no-repeat';
    preview.style.backgroundAttachment = 'scroll';
    preview.style.backgroundPosition = `-${size.x}px -${size.y}px`;

    preview.style.width = size.w + 'px';
    preview.style.height = size.h + 'px';
    preview.style.left = `${positionX}px`;

    if (!player.config.layoutControls.timelinePreview.spriteImage) {
      preview.style.backgroundSize = 'contain';
    }

    this.setTooltipText(seconds, topTooltip + size.h);
    this.show();
  };

  showTimeOnly = (seconds, offsetX, width) => {
    const preview = this.preview;

    if (is.nullOrUndefined(preview) || is.nullOrUndefined(this.tooltip)) {
      return;
    }

    const { player } = this;
    const safeWidth = width || 0;
    const safeOffset = Number.isFinite(offsetX) ? offsetX : 0;
    const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
    const left = parseInt(computedStyle(player.controls.progressContainer, 'left').replace('px', '')) || 0;

    preview.classList.add('fluid_timeline_preview_time_only');
    preview.style.background = '';
    preview.style.backgroundPosition = '';
    preview.style.backgroundSize = '';
    preview.style.height = '';

    let timeDisplay = formatTime(safeSeconds);
    if (player.streaming.live.active) {
      timeDisplay = `- ${formatTime(player.duration - safeSeconds)}`;
    }

    this.tooltipText.textContent = timeDisplay;
    this.tooltip.style.top = '';

    // Center the text bubble on the pointer while keeping it inside the bar
    const tooltipWidth = this.tooltip.offsetWidth || 60;
    const scrollLimit = Math.max(safeWidth - tooltipWidth, 0);
    const centered = safeOffset - tooltipWidth / 2;
    let positionX = left;

    if (centered >= 0) {
      positionX = (centered <= scrollLimit ? centered : scrollLimit) + left;
    }

    preview.style.width = `${tooltipWidth}px`;
    preview.style.left = `${positionX}px`;
    this.show();
  };

  setTooltipText = (seconds, top) => {
    if (is.nullOrUndefined(this.tooltip)) {
      return;
    }

    const { player } = this;
    let timeDisplay = formatTime(seconds);

    if (player.streaming.live.active) {
      timeDisplay = `- ${formatTime(player.duration - seconds)}`;
    }

    this.tooltipText.textContent = timeDisplay;
    this.tooltip.style.top = top + 'px';
  };

  getThumbSize = (second) => {
    if (is.empty(this.data)) {
      return;
    }

    for (const data of this.data) {
      if (second >= data.startTime && second <= data.endTime) {
        return data;
      }
    }
  };

  show = () => {
    if (is.nullOrUndefined(this.preview)) {
      return;
    }

    this.preview.style.visibility = 'visible';
  };

  hide = () => {
    this.pointerActive = false;
    this.pendingEvent = null;

    if (is.nullOrUndefined(this.preview)) {
      return;
    }

    this.preview.style.visibility = 'hidden';
  };

  resetView = () => {
    if (is.nullOrUndefined(this.preview)) {
      return;
    }

    this.pointerActive = false;
    this.pendingEvent = null;
    this.preview.classList.remove('fluid_timeline_preview_time_only');
    this.preview.style.visibility = 'hidden';
    this.preview.style.background = '';
    this.preview.style.backgroundPosition = '';
    this.preview.style.backgroundSize = '';
    this.preview.style.width = '';
    this.preview.style.height = '';
    this.preview.style.left = '';
  };

  renderShell = () => {
    if (!is.nullOrUndefined(this.preview) || is.nullOrUndefined(this.player.controls)) {
      return;
    }

    this.preview = createElement('div', {
      class: 'fluid_timeline_preview_thumbnails',
    });

    this.tooltip = createElement('div', {
      class: 'fluid_tooltip',
    });

    this.tooltipText = createElement('span');

    this.tooltip.appendChild(this.tooltipText);
    this.preview.appendChild(this.tooltip);

    this.player.controls.container.appendChild(this.preview);

    this.listeners();
  };

  listeners = () => {
    const { player } = this;

    // show thumbnails
    on.call(player, player.controls.progressContainer, 'mousemove touchmove', this.move);

    // hide thumbnails
    on.call(player, player.controls.progressContainer, 'mouseleave touchend', this.hide);
  };

  scrubStart = () => {};

  scrubEnd = () => {
    this.hide();
  };

  destroy = () => {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.generation += 1;
    this.request?.abort();
    this.request = null;
    this.cache.clear();
    this.imageStates.clear();
    this.data = [];
    this.pendingEvent = null;
    this.pointerActive = false;

    if (is.element(this.preview)) {
      this.preview.remove();
    }

    this.preview = null;
    this.tooltip = null;
    this.tooltipText = null;
  };
}

export default PreviewThumbnails;
