import { useRef } from 'react';
import { getHoverTimePosition } from '../utils/getHoverTimePosition';
import { timeToTimeString } from '../utils/timeToTimeString';
import { findThumbnail } from '../utils/findThumbnail';
import { PreviewThumbnail } from '../utils/parseThumbnailsVtt';
import { usePreloadedThumbnailImages } from '../hooks/usePreloadedThumbnailImages';
import { PreviewImage } from './previewImage';

interface Props {
  max: number;
  hoverTimeValue: number;
  trackWidth: number;
  seekHoverPosition: number;
  offset: number;
  isThumbActive: boolean;
  limitTimeTooltipBySides: boolean;
  label: string;
  secondsPrefix?: string;
  minutesPrefix?: string;
  getPreviewScreenUrl?: (hoverTimeValue: number) => string;
  previewThumbnails?: PreviewThumbnail[];
}

export const HoverTimeWithPreview: React.FC<Props> = ({
  max,
  hoverTimeValue,
  offset,
  trackWidth,
  seekHoverPosition,
  isThumbActive,
  limitTimeTooltipBySides,
  label,
  minutesPrefix,
  secondsPrefix,
  getPreviewScreenUrl,
  previewThumbnails,
}) => {
  const hoverTimeElement = useRef<HTMLDivElement>(null);
  const readySpriteUrls = usePreloadedThumbnailImages(
    previewThumbnails,
    isThumbActive
  );
  const hoverTimeClassName = isThumbActive ? 'hover-time active' : 'hover-time';

  const hoverTimePosition = getHoverTimePosition(
    seekHoverPosition,
    hoverTimeElement?.current,
    trackWidth,
    limitTimeTooltipBySides
  );

  const hoverTimeString = timeToTimeString(
    max,
    hoverTimeValue,
    offset,
    minutesPrefix,
    secondsPrefix
  );

  const thumbnail =
    previewThumbnails && findThumbnail(previewThumbnails, hoverTimeValue);
  // A matched thumbnail whose sprite has not preloaded yet would render an
  // empty box: show the caller-provided screen url instead until it is ready.
  const isSpriteReady = thumbnail ? readySpriteUrls.has(thumbnail.url) : false;
  const previewUrl =
    (!thumbnail || !isSpriteReady) && getPreviewScreenUrl && isThumbActive
      ? getPreviewScreenUrl(hoverTimeValue)
      : undefined;

  return (
    <div
      className={hoverTimeClassName}
      style={hoverTimePosition}
      ref={hoverTimeElement}
      data-testid="hover-time"
    >
      {isThumbActive && thumbnail && isSpriteReady && (
        <PreviewImage thumbnail={thumbnail} />
      )}
      {previewUrl !== undefined && (
        <PreviewImage thumbnail={{ fromMs: 0, toMs: 0, url: previewUrl }} />
      )}
      {label && <div>{label}</div>}
      {hoverTimeString}
    </div>
  );
};
