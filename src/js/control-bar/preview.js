import PreviewThumbnails from './preview-thumbnails';
import PreviewTime from './preview-time';

class Preview {
  constructor(player) {
    this.player = player;
    this.current = null;
    this.init();
  }

  init = () => {
    const { player } = this;
    const option = player.config.layoutControls.timelinePreview;
    const wantsThumbnails =
      (option.type === 'VTT' && isStringWithLength(option.file)) ||
      (option.type === 'static' && Array.isArray(option.frames) && option.frames.length);

    // Without thumbnail configuration the time preview is the only preview
    if (!wantsThumbnails) {
      this.current = new PreviewTime(player);
      return;
    }

    this.current = new PreviewThumbnails(player);

    // The thumbnail module renders its own shell up front and manages the
    // request lifecycle; failures (or an empty VTT) swap in the time preview.
    this.current.init().catch((error) => {
      if (error?.name !== 'AbortError') {
        player.debug.error(error);
      }
    });
  };

  // Re-bind thumbnail state when the media source changes
  rebind = (sourceKey) => {
    if (this.current?.constructor === PreviewThumbnails) {
      this.current.bindSource(sourceKey);
    }
  };

  useTimeFallback = () => {
    const { player } = this;

    if (this.current?.isFallback || this.current?.constructor !== PreviewThumbnails) {
      return;
    }

    this.current.destroy();
    const fallback = new PreviewTime(player);
    fallback.isFallback = true;
    this.current = fallback;
  };

  destroy = () => {
    this.current?.destroy?.();
    this.current = null;
  };
}

const isStringWithLength = (value) => typeof value === 'string' && value.length > 0;

export default Preview;
