import { EventEmitter } from 'node:events';

/**
 * Fake websocket client: records everything the room sends to it.
 */
export function createClient(id) {
    const client = new EventEmitter();

    client.id = id;
    client.sent = [];
    client.send = (name, data = undefined) => {
        client.sent.push({ name, data });
    };
    client.clear = () => {
        client.sent.length = 0;
    };

    return client;
}

/**
 * Names of the messages a client received
 */
export function names(client) {
    return client.sent.map(message => message.name);
}

/**
 * All received messages with the given name
 */
export function received(client, name) {
    return client.sent.filter(message => message.name === name);
}

/**
 * Replay a client's message log and verify that source and playback
 * state always belong to the same source version.
 *
 * Returns the final reconstructed state.
 */
export function replay(client) {
    let version = null;
    let playing = false;
    let time = 0;

    for (const message of client.sent) {
        if (message.name.startsWith('video:')) {
            version = message.data.version;
            playing = false;
            time = 0;
        } else if (message.name.startsWith('control:')) {
            if (version === null) {
                throw new Error(`Received "${message.name}" before any source (version mismatch).`);
            }

            switch (message.name) {
                case 'control:play':
                    playing = true;
                    time = message.data;
                    break;
                case 'control:pause':
                    playing = false;
                    time = message.data;
                    break;
                case 'control:seek':
                    time = message.data;
                    break;
                case 'control:stop':
                    playing = false;
                    time = 0;
                    break;
                default:
                    break;
            }
        }
    }

    return { version, playing, time };
}
