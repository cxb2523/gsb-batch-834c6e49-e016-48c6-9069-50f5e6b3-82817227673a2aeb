import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const aliases = {
    '@events': path.join(root, 'src/events/index.js'),
    '@events/': path.join(root, 'src/events/'),
    '@server/': path.join(root, 'src/server/'),
    '@client/': path.join(root, 'src/client/'),
};

export async function resolve(specifier, context, nextResolve) {
    if (specifier in aliases) {
        return nextResolve(pathToFileURL(aliases[specifier]).href, context);
    }

    for (const [prefix, target] of Object.entries(aliases)) {
        if (prefix.endsWith('/') && specifier.startsWith(prefix)) {
            const rest = specifier.slice(prefix.length);
            const withExt = rest.endsWith('.js') ? rest : `${rest}.js`;

            return nextResolve(pathToFileURL(path.join(target, withExt)).href, context);
        }
    }

    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);

    // Repo sources are ESM but the root package.json has no "type": "module"
    if (url.startsWith('file://') && url.includes('/src/') && !url.includes('/node_modules/')) {
        return { ...result, format: 'module' };
    }

    return result;
}
