import EventEmitter from 'tom32i-event-emitter.js';

export default class Video extends EventEmitter {
    constructor(source, url, name) {
        super();

        this.source = source;
        this.url = url;
        this.name = name;
        this.version = 0;
        this.playedAt = null;
        this.at = null;
        this.currentTime = 0;
    }

    get playing() {
        return this.playedAt !== null;
    }

    /**
     * Whether this source has a replayable address for (late) joiners
     *
     * @return {Boolean}
     */
    get available() {
        return this.url !== null;
    }

    /**
     * Serializable description of this source
     *
     * @return {Object}
     */
    getInfo() {
        const { source, url, name, available, version } = this;

        return { source, url, name, available, version };
    }

    /**
     * Register a replayable address (e.g. once the upload of a local file completed)
     *
     * @param {String} url
     */
    setUrl(url) {
        this.url = url;
    }

    get time() {
        if (this.playing) {
            return this.currentTime + (Date.now() - this.playedAt) / 1000;
        }

        return this.currentTime;
    }

    play(time = this.time) {
        if (!this.playing) {
            this.playedAt = Date.now();
            this.currentTime = time;
            this.emit('play', time);
            console.info('Video playing:', time);
        }
    }

    pause(time = this.time) {
        if (this.playing) {
            this.playedAt = null;
            this.currentTime = time;
            this.emit('pause', time);
            console.info('Video paused:', time);
        }
    }

    end() {
        if (this.playing || this.currentTime > 0) {
            this.playedAt = null;
            this.currentTime = this.time;
            this.emit('end');
            console.info('Video ended.');
        }
    }

    stop() {
        if (this.playing || this.currentTime > 0) {
            this.playedAt = null;
            this.currentTime = 0;
            this.emit('stop');
            console.info('Video stopped.');
        }
    }

    seek(time) {
        if (time !== this.currentTime) {
            if (this.playing) {
                this.playedAt = Date.now();
            }

            this.currentTime = time;
            this.emit('seek', time);
            console.info('Video seeked:', time);
        }
    }
}
