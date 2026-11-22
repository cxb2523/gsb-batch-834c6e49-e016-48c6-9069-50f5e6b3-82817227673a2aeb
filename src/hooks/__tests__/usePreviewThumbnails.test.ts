import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewThumbnails } from '../usePreviewThumbnails';
import { PreviewThumbnail } from '../../utils/parseThumbnailsVtt';

const VTT =
  'WEBVTT\n\n00:00:00.000 --> 00:01:40.000\nsheet.jpg#xywh=0,0,160,90\n';

const arrayThumbnails: PreviewThumbnail[] = [
  { fromMs: 0, toMs: 1000, url: 'inline.jpg' },
];

interface Deferred {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const createDeferred = (): Deferred => {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

describe('usePreviewThumbnails', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns array and undefined sources directly without fetching', () => {
    const { result, rerender } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      {
        initialProps: {
          source: arrayThumbnails as PreviewThumbnail[] | string | undefined,
        },
      }
    );

    expect(result.current).toBe(arrayThumbnails);
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ source: undefined });
    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads and parses a VTT url', async () => {
    fetchMock.mockResolvedValue(new Response(VTT));

    const { result } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      { initialProps: { source: '/media/thumbs.vtt' } }
    );

    expect(result.current).toBeUndefined();

    await waitFor(() => expect(result.current).toBeDefined());

    expect(result.current).toEqual([
      {
        fromMs: 0,
        toMs: 100000,
        url: 'http://localhost:3000/media/sheet.jpg',
        x: 0,
        y: 0,
        width: 160,
        height: 90,
      },
    ]);
  });

  it('ignores a late response after switching to another VTT source', async () => {
    const first = createDeferred();
    const second = createDeferred();

    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).includes('first') ? first.promise : second.promise
    );

    const { result, rerender } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      { initialProps: { source: '/media/first.vtt' } }
    );
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;

    rerender({ source: '/media/second.vtt' });

    // The superseded request must have been cancelled.
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      first.resolve(new Response(VTT));
      await Promise.resolve();
    });

    // The stale response cannot publish its thumbnails.
    expect(result.current).toBeUndefined();

    await act(async () => {
      second.resolve(
        new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsecond.jpg\n')
      );
    });

    expect(result.current).toEqual([
      { fromMs: 0, toMs: 1000, url: 'http://localhost:3000/media/second.jpg' },
    ]);
  });

  it('reflects an array or undefined immediately after a string source', async () => {
    fetchMock.mockResolvedValue(new Response(VTT));

    const { result, rerender } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      {
        initialProps: {
          source: '/media/thumbs.vtt' as
            | string
            | PreviewThumbnail[]
            | undefined,
        },
      }
    );

    await waitFor(() => expect(result.current).toBeDefined());

    rerender({ source: arrayThumbnails });
    expect(result.current).toBe(arrayThumbnails);

    rerender({ source: undefined });
    expect(result.current).toBeUndefined();
  });

  it('aborts the request and never publishes after unmount', async () => {
    const deferred = createDeferred();
    fetchMock.mockReturnValue(deferred.promise);

    const { result, unmount } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      { initialProps: { source: '/media/thumbs.vtt' } }
    );
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;

    unmount();

    expect(signal.aborted).toBe(true);

    await act(async () => {
      deferred.resolve(new Response(VTT));
      await Promise.resolve();
    });

    // The unmounted hook keeps its last (empty) state instead of updating.
    expect(result.current).toBeUndefined();
  });

  it('warns on a failed request but keeps returning undefined', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      new Response('nope', { status: 500, statusText: 'Server Error' })
    );

    const { result } = renderHook(
      ({ source }) => usePreviewThumbnails(source),
      { initialProps: { source: '/media/thumbs.vtt' } }
    );

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });
});
