import User from '@server/room/User';
import Video from '@server/room/Video';
import TimedEvent from '@server/core/TimedEvent';

export default class Room {
    constructor(id, onEmpty) {
        this.id = id;
        this.onEmpty = onEmpty;
        this.users = new Map();
        this.emptyResolver = new TimedEvent(this.checkEmpty.bind(this), 5000);
        this.video = null;
        this.videoVersion = 0;

        this.addClient = this.addClient.bind(this);
        this.removeClient = this.removeClient.bind(this);
        this.onClientReady = this.onClientReady.bind(this);
        this.onClientPlay = this.onClientPlay.bind(this);
        this.onClientPause = this.onClientPause.bind(this);
        this.onClientEnd = this.onClientEnd.bind(this);
        this.onClientStop = this.onClientStop.bind(this);
        this.onClientSeek = this.onClientSeek.bind(this);
        this.onClientVideoFile = this.onClientVideoFile.bind(this);
        this.onClientVideoUrl = this.onClientVideoUrl.bind(this);
        this.onClientVideoYoutube = this.onClientVideoYoutube.bind(this);
        this.onUserReady = this.onUserReady.bind(this);
        this.onVideoPlay = this.onVideoPlay.bind(this);
        this.onVideoPause = this.onVideoPause.bind(this);
        this.onVideoSeek = this.onVideoSeek.bind(this);
        this.onVideoStop = this.onVideoStop.bind(this);
    }

    addClient(client) {
        this.createUser(client);

        client.on('close', this.removeClient);
        client.on('user:ready', this.onClientReady);
        client.on('control:play', this.onClientPlay);
        client.on('control:pause', this.onClientPause);
        client.on('control:end', this.onClientEnd);
        client.on('control:stop', this.onClientStop);
        client.on('control:seek', this.onClientSeek);
        client.on('video:file', this.onClientVideoFile);
        client.on('video:url', this.onClientVideoUrl);
        client.on('video:youtube', this.onClientVideoYoutube);
    }

    removeClient(client) {
        this.removeUser(client);

        client.off('close', this.removeClient);
        client.off('user:ready', this.onClientReady);
        client.off('control:play', this.onClientPlay);
        client.off('control:pause', this.onClientPause);
        client.off('control:end', this.onClientEnd);
        client.off('control:stop', this.onClientStop);
        client.off('control:seek', this.onClientSeek);
        client.off('video:file', this.onClientVideoFile);
        client.off('video:url', this.onClientVideoUrl);
        client.off('video:youtube', this.onClientVideoYoutube);
    }

    createUser(client) {
        const user = new User(client.id);

        // Pause before the newcomer is registered: the pause broadcast reaches
        // existing members only, and the snapshot below already carries the
        // paused state, so nobody receives the same state twice.
        if (this.video) {
            this.video.pause();
        }

        this.send('user:add', user.id);

        this.users.set(client, user);

        this.sumUp(client, user);

        user.on('ready', this.onUserReady);
    }

    removeUser(client) {
        const user = this.users.get(client);

        this.users.delete(client);

        this.send('user:remove', user.id);

        user.off('ready', this.onUserReady);

        if (this.video) {
            this.video.pause();
        }

        this.emptyResolver.schedule();
    }

    sumUp(client, user) {
        client.send('user:me', user.id);

        this.users.forEach(other => {
            if (other !== user) {
                client.send('user:add', other.id);
                client.send('user:ready', other);
            }
        });

        if (this.video) {
            // Full snapshot, in order: source, then play/pause state, then position.
            // Sent to the newcomer only, never broadcast to the room.
            client.send(`video:${this.video.source}`, this.video.getInfo());
            client.send(this.video.playing ? 'control:play' : 'control:pause', this.video.time);
            client.send('control:seek', this.video.currentTime);
        }
    }

    onClientReady(data, client) {
        this.users.get(client).setReady(data.ready);
    }

    onClientPlay(time) {
        if (!this.video) { return; }

        this.video.play(time);
    }

    onClientPause(time) {
        if (!this.video) { return; }

        this.video.pause(time);
    }

    onClientEnd() {
        if (!this.video) { return; }

        this.video.end();
    }

    onClientStop() {
        if (!this.video) { return; }

        this.video.stop();
    }

    onClientSeek(time) {
        if (!this.video) { return; }

        this.video.seek(time);
    }

    onClientVideoFile(data, client) {
        const { name } = data;
        const url = Room.sanitizeUrl(data.url);
        const current = this.video;

        // Same local file, now with a replayable address (upload completed):
        // register the address on the current video instead of resetting the room.
        if (current && current.source === 'file' && current.name === name && !current.url && url) {
            current.setUrl(url);

            this.sendToOther(client, `video:${current.source}`, current.getInfo());

            console.info('Registered replayable address for file:', name, url);

            return;
        }

        this.setVideo(new Video('file', url, name), client);
    }

    onClientVideoUrl(data, client) {
        this.setVideo(new Video('url', data.url, data.name), client);
    }

    onClientVideoYoutube(data, client) {
        this.setVideo(new Video('youtube', data.url, data.name), client);
    }

    /**
     * Only http(s) addresses are replayable by other members
     * (blob: and object URLs only exist in the sender's browser).
     *
     * @param {String} url
     *
     * @return {String|null}
     */
    static sanitizeUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
    }

    unloadVideo() {
        if (this.video) {
            // Fully unbind the old source first: it must not broadcast anymore.
            this.video.off('play', this.onVideoPlay);
            this.video.off('pause', this.onVideoPause);
            this.video.off('seek', this.onVideoSeek);
            this.video.off('stop', this.onVideoStop);
            this.video = null;
        }
    }

    setVideo(video, client) {
        this.unloadVideo();

        // Assign the new source before broadcasting: any member joining while
        // the broadcast is in flight gets a snapshot of this same version.
        this.video = video;
        this.video.version = ++this.videoVersion;

        video.on('play', this.onVideoPlay);
        video.on('pause', this.onVideoPause);
        video.on('seek', this.onVideoSeek);
        video.on('stop', this.onVideoStop);

        this.sendToOther(client, `video:${video.source}`, video.getInfo());

        // Reset playback state and position for existing members
        this.sendToOther(client, 'control:stop');

        console.info('Loaded video:', video.source, video.url, video.name);
    }

    onUserReady(event) {
        const user = event.detail;

        this.send('user:ready', user);

        if (!user.ready && this.video) {
            this.video.pause();
        }
    }

    onVideoPlay() {
        this.send('control:play', this.video.time);
    }

    onVideoPause() {
        this.send('control:pause', this.video.time);
    }

    onVideoSeek() {
        this.send('control:seek', this.video.time);
    }

    onVideoStop() {
        this.send('control:stop');
    }

    /**
     * Send data to all clients
     *
     * @param {String} name
     * @param {Object} data
     */
    send(name, data = undefined) {
        this.users.forEach((user, client) => client.send(name, data));
    }

    /**
     * Send data to all other clients
     *
     * @param {User|Client} target
     * @param {String} name
     * @param {Object} data
     */
    sendToOther(target, name, data = undefined) {
        this.users.forEach((user, client) => {
            if (user !== target && target !== client) {
                client.send(name, data);
            }
        });
    }

    /**
     * Check if room is empty
     */
    checkEmpty() {
        if (this.users.size === 0) {
            this.onEmpty(this);
        }
    }

    /**
     * Destroy room
     */
    destroy() {
        this.unloadVideo();
        this.emptyResolver.clear();
        this.users.clear();
        this.onEmpty = null;
        this.video = null;
    }
}
