import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Server from '@server/core/Server';

let server;
let base;

before(async () => {
    server = new Server(0, '127.0.0.1');

    await new Promise(resolve => server.server.on('listening', resolve));

    base = `http://127.0.0.1:${server.server.address().port}`;
});

after(() => {
    server.socket.close();
    server.server.close();
});

test('upload returns a replayable address and the file can be downloaded', async () => {
    const content = new TextEncoder().encode('fake video content');

    const upload = await fetch(`${base}/test/file?name=movie.mp4&type=video/mp4`, {
        method: 'POST',
        body: content,
    });

    assert.equal(upload.status, 200);
    assert.equal(upload.headers.get('access-control-allow-origin'), '*');

    const { url, name } = await upload.json();

    assert.equal(name, 'movie.mp4');
    assert.ok(url.startsWith('/media/test/'), `replayable address under /media, got ${url}`);

    const download = await fetch(`${base}${url}`);

    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.equal(download.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), content);
});

test('media endpoint supports HTTP range requests (seeking)', async () => {
    const content = new TextEncoder().encode('0123456789');

    const upload = await fetch(`${base}/test/file?name=range.bin`, {
        method: 'POST',
        body: content,
    });
    const { url } = await upload.json();

    const partial = await fetch(`${base}${url}`, {
        headers: { Range: 'bytes=2-5' },
    });

    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-5/${content.length}`);
    assert.equal(await partial.text(), '2345');
});

test('missing media returns 404 (client shows the unavailable state)', async () => {
    const response = await fetch(`${base}/media/test/does-not-exist`);

    assert.equal(response.status, 404);
});

test('media of a destroyed room is cleaned up', async () => {
    const upload = await fetch(`${base}/gone/file?name=temp.mp4`, {
        method: 'POST',
        body: new TextEncoder().encode('temp'),
    });
    const { url } = await upload.json();

    assert.equal((await fetch(`${base}${url}`)).status, 200);

    // Simulate room destruction
    server.media.deleteRoom('gone');

    assert.equal((await fetch(`${base}${url}`)).status, 404);
});

test('CORS preflight is answered', async () => {
    const response = await fetch(`${base}/test/file`, { method: 'OPTIONS' });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
