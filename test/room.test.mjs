import { test } from 'node:test';
import assert from 'node:assert/strict';
import Room from '@server/room/Room';
import User from '@server/room/User';
import { createClient, names, received, replay } from './helpers.mjs';

function createRoom() {
    return new Room('room', () => {});
}

test('switching source unbinds the old video: its events no longer broadcast', () => {
    const room = createRoom();
    const alice = createClient(1);
    const bob = createClient(2);

    room.addClient(alice);
    room.addClient(bob);
    room.onClientVideoUrl({ url: 'http://videos/one.mp4', name: 'one' }, alice);

    const oldVideo = room.video;

    oldVideo.play(10);

    alice.clear();
    bob.clear();

    // Switch source
    room.onClientVideoUrl({ url: 'http://videos/two.mp4', name: 'two' }, alice);

    const newVideo = room.video;

    assert.notEqual(newVideo, oldVideo);

    // Existing members got the new source, then a state/position reset
    assert.deepEqual(names(bob), ['video:url', 'control:stop']);
    assert.equal(bob.sent[0].data.url, 'http://videos/two.mp4');
    assert.equal(bob.sent[0].data.version, 2);

    alice.clear();
    bob.clear();

    // The old source must not broadcast anything anymore
    oldVideo.pause(5);
    oldVideo.seek(7);
    oldVideo.play(8);
    oldVideo.stop();

    assert.deepEqual(alice.sent, []);
    assert.deepEqual(bob.sent, []);

    // The new source broadcasts normally
    newVideo.play(3);

    assert.deepEqual(names(alice), ['control:play']);
    assert.deepEqual(names(bob), ['control:play']);
});

test('switching source resets playback state and position for existing members', () => {
    const room = createRoom();
    const alice = createClient(1);
    const bob = createClient(2);

    room.addClient(alice);
    room.addClient(bob);
    room.onClientVideoUrl({ url: 'http://videos/one.mp4', name: 'one' }, alice);

    room.video.play(12);
    room.video.seek(30);

    bob.clear();

    room.onClientVideoUrl({ url: 'http://videos/two.mp4', name: 'two' }, alice);

    // Bob is told about the new source and reset to paused at 0
    assert.deepEqual(names(bob), ['video:url', 'control:stop']);

    const final = replay(bob);

    assert.equal(final.version, room.video.version);
    assert.equal(final.playing, false);
    assert.equal(final.time, 0);
});

test('late joiner receives a full snapshot in order: source, play/pause state, then position', () => {
    const room = createRoom();
    const alice = createClient(1);

    room.addClient(alice);
    room.onClientVideoUrl({ url: 'http://videos/one.mp4', name: 'one' }, alice);
    room.video.seek(42);
    room.video.play(42);

    alice.clear();

    const carol = createClient(3);

    room.addClient(carol);

    const order = names(carol);
    const videoIndex = order.indexOf('video:url');
    const stateIndex = order.findIndex(name => name === 'control:play' || name === 'control:pause');
    const seekIndex = order.indexOf('control:seek');

    assert.ok(videoIndex !== -1, 'snapshot carries the source');
    assert.ok(stateIndex !== -1, 'snapshot carries the play/pause state');
    assert.ok(seekIndex !== -1, 'snapshot carries the position');
    assert.ok(videoIndex < stateIndex, 'source comes before play/pause state');
    assert.ok(stateIndex < seekIndex, 'play/pause state comes before position');

    // Joining pauses the room (existing behaviour), so the snapshot says "paused"
    assert.equal(carol.sent[stateIndex].name, 'control:pause');
    assert.equal(carol.sent[seekIndex].data, room.video.currentTime);

    // The snapshot did not leak to existing members: exactly one pause
    // broadcast (the join itself), no re-broadcast of source or seek.
    assert.equal(received(alice, 'video:url').length, 0);
    assert.equal(received(alice, 'control:pause').length, 1);
    assert.equal(received(alice, 'control:seek').length, 0);
});

test('snapshot of a playing video carries the play state (sumUp)', () => {
    const room = createRoom();
    const alice = createClient(1);

    room.addClient(alice);
    room.onClientVideoUrl({ url: 'http://videos/one.mp4', name: 'one' }, alice);
    room.video.seek(15);
    room.video.play(15);

    const carol = createClient(2);

    // Direct snapshot (bypassing the join-pause behaviour)
    room.sumUp(carol, new User(carol.id));

    const order = names(carol);

    assert.deepEqual(order.slice(-3), ['video:url', 'control:play', 'control:seek']);
    assert.ok(Math.abs(carol.sent[order.length - 2].data - room.video.time) < 1);
    assert.equal(carol.sent[order.length - 1].data, room.video.currentTime);
});

test('local file source: replayable address is kept and shared, missing address is flagged unavailable', () => {
    const room = createRoom();
    const alice = createClient(1);
    const bob = createClient(2);

    room.addClient(alice);
    room.addClient(bob);
    bob.clear();

    // Alice drops a local file: no replayable address yet
    room.onClientVideoFile({ name: 'movie.mp4', url: null }, alice);

    let message = received(bob, 'video:file').pop();

    assert.equal(message.data.url, null);
    assert.equal(message.data.available, false);

    // A late joiner is told the source is unavailable (not a blank player)
    const carol = createClient(3);

    room.addClient(carol);

    message = received(carol, 'video:file').pop();

    assert.equal(message.data.url, null);
    assert.equal(message.data.available, false);

    // Upload completes: Alice registers the replayable address
    bob.clear();
    room.onClientVideoFile({ name: 'movie.mp4', url: 'http://server/media/room/abc123' }, alice);

    message = received(bob, 'video:file').pop();

    assert.equal(message.data.url, 'http://server/media/room/abc123');
    assert.equal(message.data.available, true);

    // Registering the address is not a source change: no reset broadcast
    assert.equal(received(bob, 'control:stop').length, 0);

    // The next late joiner can load the same content
    const dave = createClient(4);

    room.addClient(dave);

    message = received(dave, 'video:file').pop();

    assert.equal(message.data.url, 'http://server/media/room/abc123');
    assert.equal(message.data.available, true);
});

test('local file source: blob URLs are not accepted as replayable addresses', () => {
    const room = createRoom();
    const alice = createClient(1);

    room.addClient(alice);
    room.onClientVideoFile({ name: 'movie.mp4', url: 'blob:http://localhost/1234' }, alice);

    assert.equal(room.video.url, null);
    assert.equal(room.video.available, false);
});

test('concurrent source switch and join: every client converges to the same version', () => {
    const room = createRoom();
    const alice = createClient(1);

    room.addClient(alice);
    room.onClientVideoUrl({ url: 'http://videos/one.mp4', name: 'one' }, alice);
    room.video.play(5);

    // Bob joins right before a switch: snapshot of v1, then v2 + reset
    const bob = createClient(2);

    room.addClient(bob);
    room.onClientVideoUrl({ url: 'http://videos/two.mp4', name: 'two' }, alice);

    // Carol joins right after the switch: snapshot of v2 directly
    const carol = createClient(3);

    room.addClient(carol);

    // Dave joins, then two switches happen back to back
    const dave = createClient(4);

    room.addClient(dave);
    room.onClientVideoUrl({ url: 'http://videos/three.mp4', name: 'three' }, alice);
    room.onClientVideoFile({ name: 'four.mp4', url: 'http://server/media/room/x' }, alice);

    // Every non-sender client converges to the room's source version,
    // with source and progress always belonging to the same version.
    // (The sender resets locally, she receives no broadcasts of her own switch.)
    for (const client of [bob, carol, dave]) {
        const final = replay(client);

        assert.equal(
            final.version,
            room.video.version,
            `client ${client.id} converged to the room's source version`
        );
        assert.equal(final.playing, false);
        assert.equal(final.time, 0);
    }

    // Carol (joined between switches) never saw v1 and ended on the final version
    const carolVersions = carol.sent
        .filter(message => message.name.startsWith('video:'))
        .map(message => message.data.version);

    assert.deepEqual(carolVersions, [2, 3, 4]);
});
