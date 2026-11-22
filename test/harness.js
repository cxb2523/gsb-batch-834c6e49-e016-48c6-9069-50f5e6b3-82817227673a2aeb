'use strict';

/**
 * Загружает «Senku Ultimate Autoplay.user.js» в vm-контекст с фейковым DOM,
 * фейковыми таймерами и записывающим fetch. Всё офлайн, без зависимостей.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
    FakeDocument, FakeVideo, FakeIframe,
    FakeEvent, FakeMouseEvent, FakeKeyboardEvent,
    createClock,
} = require('./fake-dom');

const SCRIPT_PATH = path.join(__dirname, '..', 'Senku Ultimate Autoplay.user.js');
const HEARTBEAT_MS = 15000;
const TICK_MS = 1000;

function createStorage(seed = {}) {
    const m = new Map(Object.entries(seed));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
        _map: m,
    };
}

function createWorld({ href = 'https://senku.one/watch/123?episode=1&season=1', storage = {} } = {}) {
    const clock = createClock();
    const document = new FakeDocument();
    const fetchCalls = [];
    const winListeners = new Map();
    const url = new URL(href);

    const sandbox = {};
    vm.createContext(sandbox);

    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.top = sandbox;
    sandbox.document = document;
    document.defaultView = sandbox;
    sandbox.navigator = { language: 'en-US', onLine: true };
    sandbox.localStorage = createStorage(storage);
    sandbox.sessionStorage = createStorage();
    sandbox.location = {
        href, pathname: url.pathname, search: url.search, origin: url.origin,
        reload() { sandbox.__reloaded = true; },
    };
    sandbox.fetch = (fetchUrl, opts = {}) => {
        let body = null;
        try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) {}
        fetchCalls.push({ url: String(fetchUrl), method: opts.method || 'GET', body });
        return Promise.resolve({ status: 200 });
    };
    sandbox.Date = class extends Date { static now() { return clock.now; } };
    sandbox.setTimeout = clock.setTimeout;
    sandbox.clearTimeout = clock.clearTimeout;
    sandbox.setInterval = clock.setInterval;
    sandbox.clearInterval = clock.clearInterval;
    sandbox.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
    sandbox.AbortController = AbortController;
    sandbox.getComputedStyle = () => ({ display: 'block' });
    sandbox.Event = FakeEvent;
    sandbox.MouseEvent = FakeMouseEvent;
    sandbox.KeyboardEvent = FakeKeyboardEvent;
    sandbox.DOMParser = class { parseFromString() { return new FakeDocument(); } };
    sandbox.alert = () => {};
    sandbox.confirm = () => true;
    sandbox.addEventListener = (type, fn) => {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
    };
    sandbox.removeEventListener = () => {};

    const world = {
        sandbox,
        document,
        clock,
        fetchCalls,
        HEARTBEAT_MS,
        TICK_MS,

        loadScript() {
            const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
            vm.runInContext(code, sandbox, { filename: SCRIPT_PATH });
            return world;
        },

        /** Текущая сессия плагина (через отладочный крючок window.__senku). */
        session() {
            return sandbox.__senku ? sandbox.__senku.getSession() : null;
        },

        heartbeatCalls() {
            return fetchCalls.filter(c => c.url.includes('/api/v2/watch/heartbeat'));
        },

        heartbeatTimerCount() {
            return clock.countIntervals(HEARTBEAT_MS);
        },

        /** Вешает iframe плеера с video внутри на страницу. */
        addPlayer(episode) {
            const iframe = new FakeIframe(document, `https://senku.one/senku_plyr/?episode=${episode}`);
            iframe.contentWindow.location.search = `?episode=${episode}`;
            const video = new FakeVideo(iframe.contentDocument);
            video.duration = 200;
            iframe.contentDocument.body.appendChild(video);
            document.body.appendChild(iframe);
            return { iframe, video };
        },

        removePlayer(iframe) {
            iframe.remove();
        },

        /** Уход со страницы /watch (SPA-навигация). */
        navigateTo(href2) {
            const u = new URL(href2);
            sandbox.location.href = href2;
            sandbox.location.pathname = u.pathname;
            sandbox.location.search = u.search;
        },

        emitWindow(type) {
            for (const fn of (winListeners.get(type) || []).slice()) fn(new FakeEvent(type));
        },
    };

    return world;
}

/** Сброс микрозадач (async recover/heartbeat внутри vm делят очередь с тестом). */
async function flush() {
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

/** Продвигает часы на seconds тиков по 1 с; играющее видео «смотрят» (currentTime растёт). */
async function step(world, seconds, video) {
    for (let i = 0; i < seconds; i++) {
        if (video && !video.paused) video.currentTime += 1;
        world.clock.advance(TICK_MS);
        await flush();
    }
}

module.exports = { createWorld, step, flush, HEARTBEAT_MS, TICK_MS, FakeEvent };
