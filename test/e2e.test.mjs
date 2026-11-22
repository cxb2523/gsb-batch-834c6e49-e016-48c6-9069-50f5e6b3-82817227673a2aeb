import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, BinaryEncoder } from 'netcode/client';
import events from '@events';
import Server from '@server/core/Server';

const EVENT_NAMES = [
    'user:me', 'user:add', 'user:remove', 'user:ready',
    'control:play', 'control:pause', 'control:seek', 'control:stop', 'control:end',
    'video:file', 'video:url', 'video:youtube',
];

let server;
let port;
const clients = [];

before(async () => {
    server = new Server(0, '127.0.0.1');

    await new Promise(resolve => server.server.on('listening', resolve));

    port = server.server.address().port;
});

after(() => {
    while (clients.length) {
        clients.pop().close();
    }

    server.socket.close();
    server.server.close();
});

function connect(room) {
    const client = new Client(`ws://127.0.0.1:${port}/${room}/`, new BinaryEncoder(events));
    const log = [];

    for (const name of EVENT_NAMES) {
        client.addEventListener(name, event => log.push({ name, data: event.detail }));
    }

    clients.push(client);

    return { client, log };
}

async function waitFor(condition, label, timeout = 5000) {
    const start = Date.now();

    while (!condition()) {
        if (Date.now() - start > timeout) {
            throw new Error(`Timed out waiting for: ${label}`);
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function names(log) {
    return log.map(message => message.name);
}

test('end-to-end: late joiner snapshot, source switch reset, file upload for late joiners', async () => {
    // Alice joins and loads a video by URL
    const alice = connect('e2e');

    await waitFor(() => names(alice.log).includes('user:me'), 'alice connected');
    alice.client.send('video:url', { url: 'http://videos/one.mp4', name: 'one' });
    alice.client.send('control:play', 5);

    // Bob joins late: full snapshot, in order
    const bob = connect('e2e');

    await waitFor(() => names(bob.log).includes('control:seek'), 'bob snapshot complete');

    const snapshot = names(bob.log);
    const videoIndex = snapshot.indexOf('video:url');
    const stateIndex = snapshot.findIndex(name => name === 'control:play' || name === 'control:pause');
    const seekIndex = snapshot.indexOf('control:seek');

    assert.ok(videoIndex !== -1 && stateIndex !== -1 && seekIndex !== -1);
    assert.ok(videoIndex < stateIndex && stateIndex < seekIndex, 'source, then state, then position');

    // Bob's snapshot did not rebroadcast to Alice
    assert.equal(alice.log.filter(message => message.name === 'video:url').length, 0);

    // Switch to a local file with no replayable address yet
    bob.log.length = 0;
    alice.client.send('video:file', { name: 'movie.mp4', url: null });

    await waitFor(() => names(bob.log).includes('control:stop'), 'bob reset on source switch');
    assert.deepEqual(names(bob.log), ['video:file', 'control:stop']);
    assert.equal(bob.log[0].data.available, false);
    assert.equal(bob.log[0].data.url, null);

    // Alice's upload completes, she registers the replayable address
    const upload = await fetch(
        `http://127.0.0.1:${port}/e2e/file?name=movie.mp4&type=video/mp4`,
        { method: 'POST', body: 'fake video content' }
    );

    assert.equal(upload.status, 200);

    const { url } = await upload.json();

    bob.log.length = 0;
    alice.client.send('video:file', { name: 'movie.mp4', url: `http://127.0.0.1:${port}${url}` });

    await waitFor(() => names(bob.log).includes('video:file'), 'bob received replayable address');
    assert.deepEqual(names(bob.log), ['video:file'], 'address registration is not a source switch');
    assert.equal(bob.log[0].data.available, true);

    // Carol joins late: she can load the same file from the server
    const carol = connect('e2e');

    await waitFor(() => names(carol.log).includes('control:seek'), 'carol snapshot complete');

    const carolVideo = carol.log.find(message => message.name === 'video:file');

    assert.equal(carolVideo.data.available, true);
    assert.ok(carolVideo.data.url.startsWith(`http://127.0.0.1:${port}/media/e2e/`));

    // The address actually serves the content
    const download = await fetch(carolVideo.data.url);

    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'fake video content');

    // Carol and Bob are on the same source version
    const bobVideo = bob.log.find(message => message.name === 'video:file');

    assert.equal(carolVideo.data.version, bobVideo.data.version);
});
