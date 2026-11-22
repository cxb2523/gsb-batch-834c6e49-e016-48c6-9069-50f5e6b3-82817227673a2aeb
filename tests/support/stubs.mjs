// Stubs for browser-only modules that are imported transitively by the
// sources under test but are not needed for the cache behaviours we verify.

export class XzReadableStream {}

export function unzipSync() {
    return {};
}

export function ZstdInit() {
    return Promise.resolve({ ZstdSimple: { decompress: () => new Uint8Array(0) } });
}
