import { useEffect, useRef, useState } from 'react';
import { PreviewThumbnail } from '../utils/parseThumbnailsVtt';

/**
 * Warms up every sprite sheet of the current thumbnail set on the first hover
 * so scrubbing does not flicker. The preloaded `Image` references are owned by
 * the latest set only: switching sources releases the previous set immediately
 * and unmounting releases the rest, instead of accumulating for the component's
 * lifetime.
 *
 * Returns the sprite URLs whose image has finished loading, so callers can fall
 * back to another preview while the matching sprite is still in flight.
 */
export function usePreloadedThumbnailImages(
  thumbnails: PreviewThumbnail[] | undefined,
  enabled: boolean
): ReadonlySet<string> {
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const loadedUrlsRef = useRef<Set<string>>(new Set());
  const [readyUrls, setReadyUrls] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  useEffect(() => {
    if (!enabled || !thumbnails) {
      return;
    }

    const images = imagesRef.current;
    const loadedUrls = loadedUrlsRef.current;
    const urls = new Set(thumbnails.map(({ url }) => url));

    // Release sprites the current set no longer needs, straight away, so the
    // collection never grows beyond the thumbnails actually in use.
    images.forEach((image, url) => {
      if (!urls.has(url)) {
        image.src = '';
        images.delete(url);
        loadedUrls.delete(url);
      }
    });

    // Readiness only carries over for sprites that the new set still uses.
    setReadyUrls(new Set([...loadedUrls].filter((url) => urls.has(url))));

    urls.forEach((url) => {
      if (images.has(url)) {
        return;
      }

      const image = new Image();

      image.addEventListener('load', () => {
        // Ignore late events from images released by a newer set or unmount.
        if (imagesRef.current.get(url) !== image) {
          return;
        }

        loadedUrls.add(url);
        setReadyUrls((previous) => {
          const next = new Set(previous);
          next.add(url);
          return next;
        });
      });

      image.src = url;
      images.set(url, image);
    });
  }, [enabled, thumbnails]);

  // Unmount releases the whole collection, including the last active set whose
  // sprites are still referenced while preloading stays enabled.
  useEffect(
    () => () => {
      imagesRef.current.forEach((image) => {
        image.src = '';
      });
      imagesRef.current.clear();
      loadedUrlsRef.current.clear();
    },
    []
  );

  return readyUrls;
}
