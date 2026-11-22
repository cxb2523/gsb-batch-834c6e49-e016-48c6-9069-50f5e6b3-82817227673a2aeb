'use strict';

/**
 * Минимальный офлайн-DOM для прогона userscript'а в Node (vm) без браузера
 * и без внешних зависимостей. Реализует только то, что реально использует
 * «Senku Ultimate Autoplay.user.js»: элементы, классы, dataset, селекторы
 * (tag, #id, .class, [attr], [attr="v"], [attr*="v"], списки через запятую),
 * события с capture/bubble, innerHTML для модалки очереди, фейковые таймеры.
 */

class FakeEvent {
    constructor(type, opts = {}) {
        this.type = type;
        this.bubbles = !!opts.bubbles;
        this.defaultPrevented = false;
        this.target = null;
        this.currentTarget = null;
        this._stopped = false;
        this._immediate = false;
        Object.assign(this, opts);
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
    stopImmediatePropagation() { this._immediate = true; this._stopped = true; }
}

class FakeMouseEvent extends FakeEvent {}
class FakeKeyboardEvent extends FakeEvent {}

// --- селекторы ---
function parseSimpleSelector(sel) {
    const out = { tag: null, id: null, classes: [], attrs: [] };
    const re = /([#.][\w-]+|\[[^\]]+\]|[a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(sel))) {
        const tok = m[1];
        if (tok[0] === '#') out.id = tok.slice(1);
        else if (tok[0] === '.') out.classes.push(tok.slice(1));
        else if (tok[0] === '[') {
            const am = tok.slice(1, -1).match(/^([\w-]+)(?:(\*)?="([^"]*)")?$/);
            if (am) out.attrs.push({ name: am[1], contains: am[2] === '*', value: am[3] });
        } else out.tag = tok.toLowerCase();
    }
    return out;
}

function matchesSimple(el, sel) {
    const p = parseSimpleSelector(sel);
    if (p.tag && (el.tagName || '').toLowerCase() !== p.tag) return false;
    if (p.id && el.id !== p.id) return false;
    for (const c of p.classes) if (!el._classes.has(c)) return false;
    for (const a of p.attrs) {
        const v = el.getAttribute(a.name);
        if (a.value === undefined) { if (v === null) return false; }
        else if (a.contains) { if (v === null || !v.includes(a.value)) return false; }
        else if (v !== a.value) return false;
    }
    return true;
}

function matchesSelector(el, selector) {
    return selector.split(',').some(s => s.trim() && matchesSimple(el, s.trim()));
}

function normalizeOpts(opts) {
    return { capture: opts === true || !!(opts && opts.capture), once: !!(opts && opts.once), passive: !!(opts && opts.passive) };
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toUpperCase();
        this.nodeType = 1;
        this.ownerDocument = ownerDocument || null;
        this.parentNode = null;
        this.children = [];
        this._classes = new Set();
        this._listeners = new Map(); // type -> [{fn, capture, once}]
        this.dataset = {};
        this.style = {};
        this._attrs = {};
        this._text = '';
        this.id = '';
        this.title = '';
        this.value = '';
        this.disabled = false;
        this.offsetParent = null;
    }

    get className() { return Array.from(this._classes).join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

    get classList() {
        if (!this._classList) {
            const el = this;
            this._classList = {
                add: (...cs) => cs.forEach(c => el._classes.add(c)),
                remove: (...cs) => cs.forEach(c => el._classes.delete(c)),
                contains: (c) => el._classes.has(c),
                toggle: (c, force) => {
                    const want = force === undefined ? !el._classes.has(c) : !!force;
                    if (want) el._classes.add(c); else el._classes.delete(c);
                    return want;
                },
            };
        }
        return this._classList;
    }

    get textContent() {
        return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(v) { this._text = String(v); this.children = []; }

    get innerText() { return this.textContent; }
    set innerText(v) { this._text = String(v); }

    get innerHTML() { return this._html || ''; }
    set innerHTML(v) {
        v = String(v);
        this._html = v;
        this.children = [];
        this._text = '';
        if (!v) return;
        // Плоский парсер: создаём элементы по тегам с атрибутами (хватает для модалки очереди)
        const tagRe = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
        let m;
        while ((m = tagRe.exec(v))) {
            const el = new FakeElement(m[1], this.ownerDocument);
            const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
            let am;
            while ((am = attrRe.exec(m[2]))) {
                if (am[2] !== undefined) el.setAttribute(am[1], am[2]);
            }
            this.appendChild(el);
        }
    }

    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i !== -1) this.children.splice(i, 1);
        if (child.parentNode === this) child.parentNode = null;
        return child;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }

    replaceChildren(...nodes) {
        this.children = [];
        nodes.forEach(n => this.appendChild(n));
    }

    contains(node) {
        let n = node;
        while (n) { if (n === this) return true; n = n.parentNode; }
        return false;
    }

    get nextElementSibling() {
        if (!this.parentNode) return null;
        const i = this.parentNode.children.indexOf(this);
        return i >= 0 && i + 1 < this.parentNode.children.length ? this.parentNode.children[i + 1] : null;
    }

    get isConnected() {
        let n = this;
        while (n.parentNode) n = n.parentNode;
        return n.nodeType === 9;
    }

    closest(selector) {
        let n = this;
        while (n && n.nodeType === 1) {
            if (matchesSelector(n, selector)) return n;
            n = n.parentNode;
        }
        return null;
    }

    matches(selector) { return matchesSelector(this, selector); }

    _walk(fn) {
        for (const c of this.children) {
            fn(c);
            c._walk(fn);
        }
    }

    querySelector(selector) {
        let found = null;
        this._walk(el => { if (!found && matchesSelector(el, selector)) found = el; });
        return found;
    }

    querySelectorAll(selector) {
        const out = [];
        this._walk(el => { if (matchesSelector(el, selector)) out.push(el); });
        return out;
    }

    setAttribute(name, value) {
        value = String(value);
        this._attrs[name] = value;
        if (name === 'id') this.id = value;
        else if (name === 'class') this.className = value;
        else if (name === 'href' || name === 'src' || name === 'type' || name === 'rel') this[name] = value;
    }

    getAttribute(name) {
        if (name === 'class') return this.className || null;
        return name in this._attrs ? this._attrs[name] : null;
    }

    removeAttribute(name) { delete this._attrs[name]; }

    cloneNode(deep) {
        const copy = new FakeElement(this.tagName, this.ownerDocument);
        copy._attrs = { ...this._attrs };
        copy._classes = new Set(this._classes);
        copy._text = this._text;
        copy._html = this._html;
        copy.id = this.id;
        copy.dataset = { ...this.dataset };
        if (deep) for (const c of this.children) copy.appendChild(c.cloneNode(true));
        return copy;
    }

    addEventListener(type, fn, opts) {
        const o = normalizeOpts(opts);
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push({ fn, capture: o.capture, once: o.once });
    }

    removeEventListener(type, fn, opts) {
        const o = normalizeOpts(opts);
        const list = this._listeners.get(type);
        if (!list) return;
        const i = list.findIndex(l => l.fn === fn && l.capture === o.capture);
        if (i !== -1) list.splice(i, 1);
    }

    _invoke(event, capture) {
        const list = (this._listeners.get(event.type) || []).slice();
        for (const l of list) {
            if (l.capture !== capture) continue;
            if (event._immediate) return;
            if (l.once) this.removeEventListener(event.type, l.fn, l);
            l.fn.call(this, event);
        }
    }

    dispatchEvent(event) {
        if (!event.target) event.target = this;
        const path = [];
        let n = this;
        while (n) { path.unshift(n); n = n.parentNode; }
        for (const node of path) { // capture: корень -> цель
            if (event._stopped) break;
            event.currentTarget = node;
            node._invoke(event, true);
        }
        for (let i = path.length - 1; i >= 0; i--) { // bubble: цель -> корень
            if (event._stopped) break;
            event.currentTarget = path[i];
            path[i]._invoke(event, false);
        }
        return !event.defaultPrevented;
    }

    emit(type, opts) { return this.dispatchEvent(new FakeEvent(type, opts)); }

    /** Тестовый помощник: сколько всего слушателей висит на элементе. */
    listenerCount() {
        let n = 0;
        for (const list of this._listeners.values()) n += list.length;
        return n;
    }

    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }; }
    blur() {}
    focus() {}
}

class FakeDocument extends FakeElement {
    constructor() {
        super('#document', null);
        this.nodeType = 9;
        this.ownerDocument = this;
        this.documentElement = new FakeElement('html', this);
        this.head = new FakeElement('head', this);
        this.body = new FakeElement('body', this);
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.appendChild(this.documentElement);
        this.fullscreenElement = null;
        this.hidden = false;
        this.defaultView = null;
        this.title = '';
    }
    createElement(tag) { return new FakeElement(tag, this); }
    createElementNS(_ns, tag) { return new FakeElement(tag, this); }
    getElementById(id) { return this.querySelector('#' + id); }
}

class FakeVideo extends FakeElement {
    constructor(doc) {
        super('video', doc);
        this.paused = true;
        this.ended = false;
        this.seeking = false;
        this.currentTime = 0;
        this.duration = 0;
        this.playbackRate = 1;
        this.volume = 1;
        this.muted = false;
        this.error = null;
        this.currentSrc = '';
        this.playCount = 0;
    }
    play() {
        this.playCount++;
        if (this.paused) {
            this.paused = false;
            this.emit('play');
        }
        this.emit('playing');
        return Promise.resolve();
    }
    pause() {
        if (!this.paused) {
            this.paused = true;
            this.emit('pause');
        }
    }
    load() {}
}

class FakeIframe extends FakeElement {
    constructor(doc, src) {
        super('iframe', doc);
        this.setAttribute('src', src);
        this.contentDocument = new FakeDocument();
        const winListeners = new Map();
        this.contentWindow = {
            document: this.contentDocument,
            location: { search: '' },
            addEventListener: (type, fn) => {
                if (!winListeners.has(type)) winListeners.set(type, []);
                winListeners.get(type).push(fn);
            },
            removeEventListener: () => {},
        };
        this.contentDocument.defaultView = this.contentWindow;
    }
}

/** Фейковые часы: setTimeout/setInterval и ручное продвижение времени. */
function createClock(start = 1_000_000) {
    const timers = new Map();
    let nextId = 1;
    const clock = {
        now: start,
        setTimeout(fn, ms = 0, ...args) {
            const id = nextId++;
            timers.set(id, { fn, time: clock.now + ms, interval: 0, args });
            return id;
        },
        setInterval(fn, ms = 0, ...args) {
            const id = nextId++;
            timers.set(id, { fn, time: clock.now + ms, interval: ms, args });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        clearInterval(id) { timers.delete(id); },
        advance(ms) {
            const target = clock.now + ms;
            for (;;) {
                let hit = null, hitId = null;
                for (const [id, t] of timers) {
                    if (t.time <= target && (!hit || t.time < hit.time)) { hit = t; hitId = id; }
                }
                if (!hit) break;
                clock.now = hit.time;
                if (hit.interval) hit.time += hit.interval;
                else timers.delete(hitId);
                hit.fn(...hit.args);
            }
            clock.now = target;
        },
        countIntervals(ms) {
            let n = 0;
            for (const t of timers.values()) if (t.interval === ms) n++;
            return n;
        },
        timerCount() { return timers.size; },
    };
    return clock;
}

module.exports = {
    FakeEvent, FakeMouseEvent, FakeKeyboardEvent,
    FakeElement, FakeDocument, FakeVideo, FakeIframe,
    createClock,
};
