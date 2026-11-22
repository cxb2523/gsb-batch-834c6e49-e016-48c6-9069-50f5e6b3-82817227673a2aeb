import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

register(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'loader.mjs')).href);

if (typeof globalThis.location === 'undefined') {
    globalThis.location = { hostname: 'localhost', href: 'http://localhost/' };
}
if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis;
}
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
    globalThis.window.addEventListener = () => {};
    globalThis.window.removeEventListener = () => {};
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = () => 0;
}
