import { test } from 'node:test';
import assert from 'node:assert/strict';
import player, {
    loadVideoFromServer,
    loadVideoFromFile,
    fileUploaded,
    setAvailable,
    play,
    seek,
    stop,
} from '@client/store/player';

function reduce(actions) {
    return actions.reduce(player, undefined);
}

test('server snapshot resets playback state and position on source change', () => {
    const state = reduce([
        loadVideoFromFile('blob:local/1', 'one.mp4', 'video/mp4'),
        play(20),
        seek(30),
        loadVideoFromServer('url', 'two', 'http://videos/two.mp4', true, 2),
    ]);

    assert.equal(state.playing, false, 'playback state is reset');
    assert.equal(state.time, 0, 'position is reset');
    assert.equal(state.url, 'http://videos/two.mp4');
    assert.equal(state.available, true);
    assert.equal(state.version, 2);
    assert.equal(state.fromServer, true);
});

test('file source announced without address is flagged unavailable', () => {
    const state = reduce([
        loadVideoFromServer('file', 'movie.mp4', null, false, 1),
    ]);

    assert.equal(state.url, null);
    assert.equal(state.available, false, 'explicit unavailable state, not a blank player');
});

test('uploaded local file gets a replayable address, cleared on next source', () => {
    const state = reduce([
        loadVideoFromFile('blob:local/1', 'one.mp4', 'video/mp4'),
        fileUploaded('/media/room/abc'),
    ]);

    assert.equal(state.uploadedUrl, '/media/room/abc');

    const next = reduce([
        loadVideoFromFile('blob:local/1', 'one.mp4', 'video/mp4'),
        fileUploaded('/media/room/abc'),
        loadVideoFromServer('url', 'two', 'http://videos/two.mp4', true, 2),
    ]);

    assert.equal(next.uploadedUrl, null);
});

test('unavailable flag can be set on load error and resets on new source', () => {
    const state = reduce([
        loadVideoFromServer('url', 'clip', 'http://videos/gone.mp4', true, 1),
        setAvailable(false),
    ]);

    assert.equal(state.available, false);

    const recovered = reduce([
        loadVideoFromServer('url', 'clip', 'http://videos/gone.mp4', true, 1),
        setAvailable(false),
        loadVideoFromServer('url', 'clip2', 'http://videos/ok.mp4', true, 2),
    ]);

    assert.equal(recovered.available, true);
});

test('stop resets state and position (source switch reset)', () => {
    const state = reduce([
        loadVideoFromServer('url', 'clip', 'http://videos/ok.mp4', true, 1),
        play(10),
        stop(),
    ]);

    assert.equal(state.playing, false);
    assert.equal(state.time, 0);
});
