import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePreloadedThumbnailImages } from '../usePreloadedThumbnailImages';
import { PreviewThumbnail } from '../../utils/parseThumbnailsVtt';
import { FakeImage } from '../../test/FakeImage';

const makeThumbnails = (urls: string[]): PreviewThumbnail[] =>
  urls.map((url, index) => ({
    fromMs: index * 1000,
    toMs: (index + 1) * 1000,
    url,
  }));

describe('usePreloadedThumbnailImages', () => {
  afterEach(() => {
    FakeImage.restore();
  });

  it('does not preload while disabled and starts on activation', () => {
    FakeImage.install();
    const thumbnails = makeThumbnails(['sprite-a.jpg']);

    const { result, rerender } = renderHook(
      ({ enabled }) => usePreloadedThumbnailImages(thumbnails, enabled),
      { initialProps: { enabled: false } }
    );

    expect(FakeImage.instances).toHaveLength(0);
    expect(result.current.size).toBe(0);

    rerender({ enabled: true });

    const image = FakeImage.getBySrc('sprite-a.jpg');
    expect(image).toBeDefined();
    expect(result.current.has('sprite-a.jpg')).toBe(false);

    act(() => image!.load());

    expect(result.current.has('sprite-a.jpg')).toBe(true);
  });

  it('deduplicates sprite urls and reports readiness per url', () => {
    FakeImage.install();
    const thumbnails = makeThumbnails([
      'sprite-a.jpg',
      'sprite-a.jpg',
      'sprite-b.jpg',
    ]);

    const { result } = renderHook(() =>
      usePreloadedThumbnailImages(thumbnails, true)
    );

    expect(FakeImage.instances.map(({ src }) => src).sort()).toEqual([
      'sprite-a.jpg',
      'sprite-b.jpg',
    ]);

    act(() => FakeImage.getBySrc('sprite-a.jpg')!.load());

    expect([...result.current]).toEqual(['sprite-a.jpg']);

    act(() => FakeImage.getBySrc('sprite-b.jpg')!.load());

    expect(result.current.size).toBe(2);
  });

  it('releases images of the previous set when the source changes', () => {
    FakeImage.install();
    const first = makeThumbnails(['sprite-a.jpg', 'sprite-b.jpg']);
    const second = makeThumbnails(['sprite-b.jpg', 'sprite-c.jpg']);

    const { result, rerender } = renderHook(
      ({ thumbnails }) => usePreloadedThumbnailImages(thumbnails, true),
      { initialProps: { thumbnails: first } }
    );

    act(() => FakeImage.getBySrc('sprite-a.jpg')!.load());
    act(() => FakeImage.getBySrc('sprite-b.jpg')!.load());
    expect(result.current.size).toBe(2);

    const released = FakeImage.getBySrc('sprite-a.jpg')!;
    rerender({ thumbnails: second });

    // The sprite no longer referenced loses its Image reference...
    expect(released.src).toBe('');
    // ...while the shared sprite is kept and stays ready.
    expect(FakeImage.getBySrc('sprite-b.jpg')!.src).toBe('sprite-b.jpg');
    expect([...result.current]).toEqual(['sprite-b.jpg']);

    act(() => FakeImage.getBySrc('sprite-c.jpg')!.load());
    expect([...result.current].sort()).toEqual([
      'sprite-b.jpg',
      'sprite-c.jpg',
    ]);

    // A load event arriving on the released image must not republish it.
    act(() => released.load());
    expect(result.current.has('sprite-a.jpg')).toBe(false);
  });

  it('releases every image on unmount', () => {
    FakeImage.install();
    const thumbnails = makeThumbnails(['sprite-a.jpg', 'sprite-b.jpg']);

    const { unmount } = renderHook(() =>
      usePreloadedThumbnailImages(thumbnails, true)
    );

    const images = [...FakeImage.instances];
    unmount();

    expect(images.map((image) => image.src)).toEqual(['', '']);
    expect(FakeImage.instances.filter(({ src }) => src !== '')).toHaveLength(0);
  });

  it('keeps warmed sprites while hovering ends and rebuilds for a new set', () => {
    FakeImage.install();
    const first = makeThumbnails(['sprite-a.jpg']);
    const second = makeThumbnails(['sprite-b.jpg']);

    const { result, rerender } = renderHook(
      ({ thumbnails, enabled }) =>
        usePreloadedThumbnailImages(thumbnails, enabled),
      { initialProps: { thumbnails: first, enabled: true } }
    );

    act(() => FakeImage.getBySrc('sprite-a.jpg')!.load());
    expect(result.current.has('sprite-a.jpg')).toBe(true);

    // Leaving hover keeps the warmed image and its readiness, so re-entering
    // hover never flashes the fallback frame.
    rerender({ thumbnails: first, enabled: false });
    expect(FakeImage.getBySrc('sprite-a.jpg')!.src).toBe('sprite-a.jpg');

    rerender({ thumbnails: first, enabled: true });
    expect(result.current.has('sprite-a.jpg')).toBe(true);

    // A different set starts with no ready sprites and drops the old images.
    rerender({ thumbnails: second, enabled: true });
    expect(result.current.size).toBe(0);
    expect(FakeImage.getReleased().map(({ src }) => src)).toEqual(['']);
    expect(FakeImage.getBySrc('sprite-b.jpg')).toBeDefined();
  });
});
