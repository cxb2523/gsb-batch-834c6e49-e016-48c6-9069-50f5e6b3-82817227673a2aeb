// Node ESM loader for unit tests: resolves 'three' to a test double, stubs
// browser-only packages pulled in transitively, and adds '.ts' resolution for
// relative imports inside the TypeScript sources.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const rootDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repoRoot = path.resolve(rootDir, '../..');
const fakeThree = pathToFileURL(path.join(repoRoot, 'tests/support/fake-three.mjs')).href;
const stubs = pathToFileURL(path.join(repoRoot, 'tests/support/stubs.mjs')).href;

const stubbed = new Set(['xz-decompress', 'fflate', '@oneidentity/zstd-js/wasm/decompress']);

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'three' || specifier.startsWith('three/')) {
        return { url: fakeThree, shortCircuit: true };
    }
    if (stubbed.has(specifier)) {
        return { url: stubs, shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
        const parentPath = new URL(context.parentURL);
        const base = path.resolve(path.dirname(parentPath.pathname.replace(/^\/([A-Za-z]:)/, '$1')), specifier);
        for (const cand of [base + '.ts', base + '.js', base + '.mjs', path.join(base, 'index.ts')]) {
            if (fs.existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
        }
    }
    return nextResolve(specifier, context);
}

/** .glsl 文件在测试中按空字符串模块处理（着色器不影响缓存逻辑） */
export async function load(url, context, nextLoad) {
    if (url.endsWith('.glsl')) {
        return { format: 'module', source: 'export default "";', shortCircuit: true };
    }
    return nextLoad(url, context);
}
