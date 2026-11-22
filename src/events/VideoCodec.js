import { Codec, BooleanCodec, StringLongCodec, UInt32Codec } from 'netcode/encoder';

/**
 * Video event codec
 *
 * Carries everything a client needs to load (or flag) a source:
 * - version:   room-side source version, incremented on every source change
 * - available: whether the source has a replayable address
 * - name:      display name of the video
 * - url:       replayable address (empty string encodes null)
 */
export default class VideoCodec extends Codec {
    constructor() {
        super();

        this.uint32Codec = new UInt32Codec();
        this.booleanCodec = new BooleanCodec();
        this.stringLongCodec = new StringLongCodec();
    }

    getByteLength(data) {
        return this.uint32Codec.getByteLength()
            + this.booleanCodec.getByteLength()
            + this.stringLongCodec.getByteLength(data.name || '')
            + this.stringLongCodec.getByteLength(data.url || '');
    }

    encode(cursor, data) {
        this.uint32Codec.encode(cursor, data.version || 0);
        this.booleanCodec.encode(cursor, data.available !== false);
        this.stringLongCodec.encode(cursor, data.name || '');
        this.stringLongCodec.encode(cursor, data.url || '');
    }

    decode(cursor) {
        const version = this.uint32Codec.decode(cursor);
        const available = this.booleanCodec.decode(cursor);
        const name = this.stringLongCodec.decode(cursor);
        const url = this.stringLongCodec.decode(cursor) || null;

        return { version, available, name, url };
    }
}
