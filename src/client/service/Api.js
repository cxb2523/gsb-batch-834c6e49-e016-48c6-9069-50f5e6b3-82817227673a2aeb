import { Client, BinaryEncoder } from 'netcode/client';
import events from '@events';

export default class Api {
    constructor(host, protocol) {
        this.host = host;
        this.protocol = protocol;
        this.room = null;

        this.play = this.play.bind(this);
        this.pause = this.pause.bind(this);
    }

    addEventListener(name, callback) {
        this.client.addEventListener(name, callback);
    }

    removeEventListener(name, callback) {
        this.client.removeEventListener(name, callback);
    }

    join(room) {
        if (this.client) {
            throw new Error(`Already connected to ${this.client.socket.url}`);
        }

        this.room = room;
        this.client = new Client(
            `${this.protocol}//${this.host}/${room}/`,
            new BinaryEncoder(events)
        );
    }

    leave() {
        this.client.close();
        this.client = null;
        this.room = null;
    }

    play(time) {
        this.client.send('control:play', time);
    }

    pause(time) {
        this.client.send('control:pause', time);
    }

    end() {
        this.client.send('control:end');
    }

    stop() {
        this.client.send('control:stop');
    }

    seek(time) {
        this.client.send('control:seek', time);
    }

    setReady(ready) {
        this.client.send('user:ready', { id: 0, ready });
    }

    loadVideo(source, name, url) {
        this.client.send(`video:${source}`, { url, name });
    }

    /**
     * Upload a local file so the server can hand a replayable address
     * to every (late) joiner of the room.
     *
     * @param {File} file
     *
     * @return {Promise} Resolves with { url, name }
     */
    uploadFile(file) {
        if (!this.room) {
            return Promise.reject(new Error('Cannot upload: not in a room.'));
        }

        const protocol = this.protocol.replace('ws', 'http');
        const name = encodeURIComponent(file.name);
        const type = encodeURIComponent(file.type || 'application/octet-stream');

        return fetch(`${protocol}//${this.host}/${this.room}/file?name=${name}&type=${type}`, {
            method: 'POST',
            body: file,
        }).then(response => {
            if (!response.ok) {
                throw new Error(`Upload failed with status ${response.status}`);
            }

            return response.json();
        });
    }
}
