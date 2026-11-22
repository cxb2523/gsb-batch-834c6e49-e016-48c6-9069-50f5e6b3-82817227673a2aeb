import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinaryEncoder } from 'netcode/encoder';
import events from '@events';

const encoder = new BinaryEncoder(events);

function roundTrip(name, data) {
    return encoder.decode(encoder.encode(name, data)).data;
}

test('video codec round-trips a full payload', () => {
    const data = { version: 3, available: true, name: 'movie.mp4', url: 'http://server/media/room/abc' };

    assert.deepEqual(roundTrip('video:file', data), data);
    assert.deepEqual(roundTrip('video:url', data), data);
    assert.deepEqual(roundTrip('video:youtube', data), data);
});

test('video codec encodes a missing address as unavailable', () => {
    const decoded = roundTrip('video:file', { version: 1, available: false, name: 'movie.mp4', url: null });

    assert.equal(decoded.url, null);
    assert.equal(decoded.available, false);
    assert.equal(decoded.name, 'movie.mp4');
    assert.equal(decoded.version, 1);
});

test('video codec defaults (sender side only provides name and url)', () => {
    const decoded = roundTrip('video:url', { name: 'clip', url: 'http://videos/clip.mp4' });

    assert.equal(decoded.available, true);
    assert.equal(decoded.version, 0);
    assert.equal(decoded.url, 'http://videos/clip.mp4');
});

test('control events still round-trip', () => {
    assert.equal(roundTrip('control:seek', 12.5), 12.5);
    assert.equal(roundTrip('control:play', 0), 0);
    assert.equal(roundTrip('control:stop', undefined), null);
});
