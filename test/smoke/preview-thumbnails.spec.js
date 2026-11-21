const { expect, test } = require('@playwright/test');
const { loadPlayer } = require('./helpers');

const FIRST_VTT = '/thumbs-first.vtt';
const SECOND_VTT = '/thumbs-second.vtt';

const firstVtt = `WEBVTT

00:00:00.000 --> 00:00:50.000
/first-frame.jpg#xywh=0,0,200,84
`;

const secondVtt = `WEBVTT

00:00:00.000 --> 00:00:50.000
/second-frame.jpg#xywh=0,0,200,84
`;

const fulfillVtt = (route, body) => route.fulfill({ contentType: 'text/vtt', body });

const routeDeferredVtt = (page, url, body) => {
  const deferred = {};
  deferred.promise = new Promise((resolve) => {
    deferred.release = resolve;
  });

  page.route(`**${url}`, async (route) => {
    await deferred.promise;

    // The request may already have been aborted (source switch / destroy)
    try {
      await fulfillVtt(route, body);
    } catch (_) {
      /* no-op: the aborted request can no longer be fulfilled */
    }
  });

  return deferred;
};

const routeVtt = (page, url, body) => {
  page.route(`**${url}`, (route) => fulfillVtt(route, body));
};

// Serve a real, decodable JPEG so the browser's image load succeeds
const routeImage = (page, url) =>
  page.route(`**${url}`, (route) =>
    route.fulfill({ contentType: 'image/jpeg', path: require.resolve('../static/video-thumbnail.jpg') }),
  );

const setupPage = async (page, vttFile) => {
  await loadPlayer(
    page,
    `<video id="player" muted width="640" height="360">
      <source src="/static/sample.webm" type="video/webm">
    </video>`,
  );

  await page.evaluate((file) => {
    const media = document.getElementById('player');
    Object.defineProperty(media, 'duration', { configurable: true, value: 100 });

    window.fluidPlayer('player', {
      layoutControls: { timelinePreview: { file, type: 'VTT' } },
    });
  }, vttFile);
};

const previewState = () => {
  const preview = document.querySelector('.fluid_timeline_preview_thumbnails');
  if (!preview) {
    return { exists: false };
  }

  return {
    exists: true,
    visibility: preview.style.visibility,
    timeOnly: preview.classList.contains('fluid_timeline_preview_time_only'),
    backgroundImage: preview.style.backgroundImage || preview.style.background || '',
    tooltip: preview.querySelector('.fluid_tooltip span').textContent,
  };
};

const previewStateOnPage = (page) => page.evaluate(previewState);

// The media element resolves relative src values against the document base URI
const resolve = (path) => new URL(path, 'http://127.0.0.1:8080').href;

// Dispatch a full mouse drag on the progress bar at the given width ratio
const dragAt = (page, ratio) =>
  page.evaluate((positionRatio) => {
    const internals = window.fluidPlayerDebug.at(-1).internals;
    const progress = internals.controls.progressContainer;
    const rect = progress.getBoundingClientRect();
    const clientX = rect.left + rect.width * positionRatio;
    const clientY = rect.top + rect.height / 2;

    progress.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
  }, ratio);

const endDrag = (page, ratio) =>
  page.evaluate((positionRatio) => {
    const internals = window.fluidPlayerDebug.at(-1).internals;
    const progress = internals.controls.progressContainer;
    const rect = progress.getBoundingClientRect();
    const clientX = rect.left + rect.width * positionRatio;
    const clientY = rect.top + rect.height / 2;

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
  }, ratio);

const hoverAt = (page, ratio) =>
  page.evaluate((positionRatio) => {
    const internals = window.fluidPlayerDebug.at(-1).internals;
    const progress = internals.controls.progressContainer;
    const rect = progress.getBoundingClientRect();
    progress.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: rect.left + rect.width * positionRatio,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }, ratio);

test('dragging while the VTT is still loading shows only the time text, then the matching frame', async ({
  page,
}) => {
  const first = routeDeferredVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');

  await setupPage(page, FIRST_VTT);

  const shell = page.locator('.fluid_timeline_preview_thumbnails');
  await expect(shell).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.request !== null))
    .toBe(true);

  // Start dragging at 50% of the bar while the request is still in flight
  await dragAt(page, 0.5);

  const loading = await previewStateOnPage(page);
  expect(loading).toMatchObject({
    exists: true,
    visibility: 'visible',
    timeOnly: true,
    tooltip: '00:50',
  });
  expect(loading.backgroundImage).toBe('');

  // Releasing the response must render the frame within the same drag
  first.release();
  await expect.poll(async () => (await previewStateOnPage(page)).timeOnly).toBe(false);

  const loaded = await previewStateOnPage(page);
  expect(loaded).toMatchObject({
    visibility: 'visible',
    timeOnly: false,
    tooltip: '00:50',
  });
  expect(loaded.backgroundImage).toContain('first-frame.jpg');

  await endDrag(page, 0.5);
  await expect(shell).toHaveCSS('visibility', 'hidden');
});

test('the loaded frame matches the hovered time and is reused from the source cache', async ({ page }) => {
  await routeVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');

  const vttRequests = [];
  page.on('request', (request) => {
    if (request.url().includes(FIRST_VTT)) {
      vttRequests.push(request.url());
    }
  });

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);

  // Hover at 50%: the single cue spans the whole duration and must be shown
  await hoverAt(page, 0.5);

  await expect.poll(async () => (await previewStateOnPage(page)).backgroundImage).toContain('first-frame.jpg');
  const hovered = await previewStateOnPage(page);
  expect(hovered).toMatchObject({ visibility: 'visible', timeOnly: false, tooltip: '00:50' });

  // A second drag on the same source must not trigger another VTT request
  const requestsBefore = vttRequests.length;
  await dragAt(page, 0.5);
  await expect.poll(async () => (await previewStateOnPage(page)).backgroundImage).toContain('first-frame.jpg');
  await endDrag(page, 0.5);
  expect(vttRequests).toHaveLength(requestsBefore);
  expect(vttRequests).toHaveLength(1);

  const cached = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return { sourceKey: current.sourceKey, cacheHits: current.cache.size, loaded: current.loaded };
  });
  expect(cached).toMatchObject({
    sourceKey: resolve('/static/sample.webm'),
    cacheHits: 1,
    loaded: true,
  });
});

test('the VTT loads before any media source and is adopted by the first source without re-requesting', async ({
  page,
}) => {
  await routeVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');

  const vttRequests = [];
  page.on('request', (request) => {
    if (request.url().includes(FIRST_VTT)) {
      vttRequests.push(request.url());
    }
  });

  // Initialize without a <source>, like the fallback VTT smoke cases
  await loadPlayer(page, '<video id="player" width="640" height="360"></video>');
  await page.evaluate((file) => {
    window.fluidPlayer('player', {
      layoutControls: { timelinePreview: { file, type: 'VTT' } },
    });
  }, FIRST_VTT);

  // The bootstrap request fires even though there is no media source yet
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);
  const bootstrap = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return { sourceKey: current.sourceKey, cacheKeys: [...current.cache.keys()] };
  });
  expect(bootstrap).toEqual({ sourceKey: '', cacheKeys: [''] });

  // Assigning the first media source adopts the in-flight data, no new request
  await page.evaluate(() => {
    window.fluidPlayerDebug
      .at(-1)
      .instance.src({ src: '/static/sample.webm', type: 'video/webm' });
  });

  const adopted = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return {
      sourceKey: current.sourceKey,
      cacheKeys: [...current.cache.keys()],
      loaded: current.loaded,
      dataImages: current.data.map((frame) => frame.image),
    };
  });
  expect(adopted).toEqual({
    sourceKey: resolve('/static/sample.webm'),
    cacheKeys: [resolve('/static/sample.webm')],
    loaded: true,
    dataImages: ['/first-frame.jpg'],
  });
  expect(vttRequests).toHaveLength(1);
});

test('a late response from the previous source is ignored after switching sources', async ({ page }) => {
  const first = routeDeferredVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');
  await routeImage(page, '/second-frame.jpg');
  await routeVtt(page, SECOND_VTT, secondVtt);

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.request !== null))
    .toBe(true);

  // Switch to a new media source (and its own VTT) before the first responds
  await page.evaluate((secondFile) => {
    const api = window.fluidPlayerDebug.at(-1).instance;
    const player = window.fluidPlayerDebug.at(-1).internals;
    player.config.layoutControls.timelinePreview.file = secondFile;
    api.src({ src: '/second-media.webm', type: 'video/webm' });
  }, SECOND_VTT);

  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.sourceKey))
    .toBe(resolve('/second-media.webm'));

  // The second source's data loads
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);

  // Now the stale first response arrives: it must never be written
  first.release();
  await page.waitForTimeout(100);

  const afterLateResponse = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return {
      sourceKey: current.sourceKey,
      dataImages: current.data.map((frame) => frame.image),
      cacheKeys: [...current.cache.keys()],
    };
  });
  expect(afterLateResponse).toEqual({
    sourceKey: resolve('/second-media.webm'),
    dataImages: ['/second-frame.jpg'],
    cacheKeys: [resolve('/second-media.webm')],
  });

  // The visible frame for the new source is the second image
  await dragAt(page, 0.25);
  await expect
    .poll(async () => (await previewStateOnPage(page)).backgroundImage)
    .toContain('second-frame.jpg');
  const state = await previewStateOnPage(page);
  expect(state.backgroundImage).toContain('second-frame.jpg');
  expect(state.backgroundImage).not.toContain('first-frame.jpg');
  await endDrag(page, 0.25);
});

test('switching sources aborts the in-flight request and clears the previous source cache', async ({ page }) => {
  const aborted = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes(FIRST_VTT)) {
      aborted.push(request.url());
    }
  });

  const first = routeDeferredVtt(page, FIRST_VTT, firstVtt);
  await routeVtt(page, SECOND_VTT, secondVtt);
  await routeImage(page, '/second-frame.jpg');

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.request !== null))
    .toBe(true);

  await page.evaluate((secondFile) => {
    const api = window.fluidPlayerDebug.at(-1).instance;
    const player = window.fluidPlayerDebug.at(-1).internals;
    player.config.layoutControls.timelinePreview.file = secondFile;
    api.src({ src: '/second-media.webm', type: 'video/webm' });
  }, SECOND_VTT);

  await expect.poll(() => aborted).toHaveLength(1);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);

  // Old source cache entries must not survive the switch
  const state = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return { keys: [...current.cache.keys()], sourceKey: current.sourceKey };
  });
  expect(state).toEqual({
    keys: [resolve('/second-media.webm')],
    sourceKey: resolve('/second-media.webm'),
  });

  first.release();
});

test('an empty source list cancels the pending thumbnail request without applying data', async ({ page }) => {
  const aborted = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes(FIRST_VTT)) {
      aborted.push(request.url());
    }
  });

  const first = routeDeferredVtt(page, FIRST_VTT, firstVtt);

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.request !== null))
    .toBe(true);

  await page.evaluate(() => {
    window.fluidPlayerDebug.at(-1).instance.src([]);
  });

  await expect.poll(() => aborted).toHaveLength(1);

  const state = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return {
      sourceKey: current.sourceKey,
      loaded: current.loaded,
      dataLength: current.data.length,
      request: current.request,
      cacheSize: current.cache.size,
    };
  });
  expect(state).toEqual({ sourceKey: null, loaded: false, dataLength: 0, request: null, cacheSize: 0 });

  // The late response must remain inert
  first.release();
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => {
    const current = window.fluidPlayerDebug.at(-1).internals.preview.current;
    return { sourceKey: current.sourceKey, dataLength: current.data.length, loaded: current.loaded };
  });
  expect(after).toEqual({ sourceKey: null, dataLength: 0, loaded: false });
});

test('scrub pause and release resume stay paired, including a mid-drag source switch', async ({ page }) => {
  await routeVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);

  const counts = await page.evaluate(() => {
    const media = document.getElementById('player');
    const player = window.fluidPlayerDebug.at(-1).internals;

    let pauseCount = 0;
    let playCount = 0;
    media.pause = () => {
      pauseCount++;
      Object.defineProperty(media, 'paused', { configurable: true, value: true });
    };
    media.play = () => {
      playCount++;
      Object.defineProperty(media, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    };
    Object.defineProperty(media, 'paused', { configurable: true, value: false });

    const progress = player.controls.progressContainer;
    const rect = progress.getBoundingClientRect();
    const point = (x) => ({ bubbles: true, clientX: rect.left + x, clientY: rect.top + rect.height / 2 });

    // First drag lasts long enough for the 300ms scrub pause to fire
    progress.dispatchEvent(new MouseEvent('mousedown', point(100)));
    document.dispatchEvent(new MouseEvent('mousemove', point(120)));

    return new Promise((resolve) => {
      setTimeout(() => {
        document.dispatchEvent(new MouseEvent('mouseup', point(120)));

        // Second drag interrupted by a source switch before release. The key
        // only identifies the new source; no VTT for it is needed for this
        // timer/listener teardown assertion.
        progress.dispatchEvent(new MouseEvent('mousedown', point(200)));
        player.preview.rebind('scrub-interrupted-source');
        player.progressBar.cancelScrub();

        resolve({ pauseCount, playCount });
      }, 400);
    });
  });

  expect(counts).toEqual({ pauseCount: 1, playCount: 1 });

  // No scrub document listeners or timers remain after the interrupted drag
  const cleanup = await page.evaluate(() => {
    const player = window.fluidPlayerDebug.at(-1).internals;
    const hasDocumentScrubListeners = player.eventListeners.some(
      (entry) =>
        entry.element === document &&
        (entry.callback === player.progressBar.move || entry.callback === player.progressBar.end),
    );

    return {
      hasDocumentScrubListeners,
      scrubbing: player.progressBar.scrubbing,
      timer: player.progressBar.timer,
      pausedByScrub: player.progressBar.pausedByScrub,
    };
  });
  expect(cleanup).toEqual({
    hasDocumentScrubListeners: false,
    scrubbing: false,
    timer: null,
    pausedByScrub: false,
  });
});

test('destroy aborts the pending request and leaves no timers, requests or preview DOM behind', async ({
  page,
}) => {
  const aborted = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes(FIRST_VTT)) {
      aborted.push(request.url());
    }
  });

  const first = routeDeferredVtt(page, FIRST_VTT, firstVtt);

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.request !== null))
    .toBe(true);

  // Start a drag so scrub timers/listeners exist at destroy time
  await page.evaluate(() => {
    const media = document.getElementById('player');
    Object.defineProperty(media, 'paused', { configurable: true, value: false });
  });
  await dragAt(page, 0.25);

  const timerSnapshot = await page.evaluate(() => {
    const player = window.fluidPlayerDebug.at(-1).internals;
    return {
      progressTimer: player.progressBar.timer,
      scrubbing: player.progressBar.scrubbing,
      hasScrubListeners: player.eventListeners.some(
        (entry) =>
          entry.element === document &&
          (entry.callback === player.progressBar.move || entry.callback === player.progressBar.end),
      ),
    };
  });
  expect(timerSnapshot.progressTimer).not.toBeNull();
  expect(timerSnapshot.scrubbing).toBe(true);
  expect(timerSnapshot.hasScrubListeners).toBe(true);

  await page.evaluate(async () => {
    await window.fluidPlayerDebug.at(-1).instance.destroy();
  });

  await expect.poll(() => aborted).toHaveLength(1);
  await expect(page.locator('.fluid_timeline_preview_thumbnails')).toHaveCount(0);
  await expect(page.locator('.fluid_timeline_preview_time')).toHaveCount(0);

  // A late response after destroy must not resurrect any state
  first.release();
  await page.waitForTimeout(100);
  await expect(page.locator('.fluid_timeline_preview_thumbnails')).toHaveCount(0);
  await expect(page.locator('.fluid_video_wrapper')).toHaveCount(0);
});

test('keyboard seeking, buffering and aria slider attributes keep working alongside previews', async ({
  page,
}) => {
  await routeVtt(page, FIRST_VTT, firstVtt);
  await routeImage(page, '/first-frame.jpg');

  await setupPage(page, FIRST_VTT);
  await expect
    .poll(() => page.evaluate(() => window.fluidPlayerDebug.at(-1).internals.preview.current.loaded))
    .toBe(true);

  const state = await page.evaluate(() => {
    const player = window.fluidPlayerDebug.at(-1).internals;
    const progress = player.controls.progressContainer;

    let storedCurrentTime = 10;
    Object.defineProperty(player.media, 'currentTime', {
      configurable: true,
      get: () => storedCurrentTime,
      set: (value) => {
        storedCurrentTime = value;
      },
    });
    Object.defineProperty(player.media, 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 40 },
    });

    // Keyboard arrow seek
    progress.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const afterArrow = {
      currentTime: player.media.currentTime,
      ariaMax: progress.getAttribute('aria-valuemax'),
      ariaNow: progress.getAttribute('aria-valuenow'),
      ariaText: progress.getAttribute('aria-valuetext'),
    };

    // Buffer rendering
    player.listeners.buffer();
    const bufferHtml = player.controls.loadProgress.innerHTML;

    progress.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    const afterHome = {
      currentTime: player.media.currentTime,
      ariaNow: progress.getAttribute('aria-valuenow'),
    };

    return { afterArrow, bufferHtml, afterHome };
  });

  expect(state.afterArrow).toMatchObject({ currentTime: 15, ariaMax: '100', ariaNow: '15' });
  expect(typeof state.afterArrow.ariaText).toBe('string');
  expect(state.afterArrow.ariaText).not.toBe('');
  expect(state.bufferHtml).toContain('buffer');
  expect(state.afterHome).toMatchObject({ currentTime: 0, ariaNow: '0' });
});
