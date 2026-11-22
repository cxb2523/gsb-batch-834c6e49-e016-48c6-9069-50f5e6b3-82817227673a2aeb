import { Server as NetcodeServer, BinaryEncoder } from 'netcode/server';
import events from '@events';
import RoomManager from '@server/room/RoomManager';
import MediaStore from '@server/core/MediaStore';

export default class Server extends NetcodeServer {
    constructor(port = 8001, hostname = '0.0.0.0') {
        super(port, hostname, new BinaryEncoder(events), 30, Math.pow(2, 12), undefined, false);

        this.joinMatcher = new RegExp('^/([^/]+)/?$');
        this.uploadMatcher = new RegExp('^/([^/]+)/file/?$');
        this.mediaMatcher = new RegExp('^/media/([^/]+)/([^/]+)$');
        this.media = new MediaStore();
        this.rooms = new RoomManager(room => this.media.deleteRoom(room.id));
        // 4 GiB upload limit
        this.maxUploadSize = 4 * Math.pow(1024, 3);

        this.onRequest = this.onRequest.bind(this);
        this.onJoin = this.onJoin.bind(this);
        this.onLeave = this.onLeave.bind(this);
        this.onClientError = this.onClientError.bind(this);

        this.start();
    }

    /**
     * Start websocket server
     */
    start() {
        super.start();

        this.on('client:join', this.onJoin);
        this.on('client:leave', this.onLeave);

        console.info(`Listening at "${this.host}:${this.port}"`);
    }

    /**
     * @param {Socket} socket
     * @param {Request} request
     */
    onConnection(socket, request) {
        // Don't allow connection on any url
        if (!this.joinMatcher.test(request.url)) {
            console.warn(`Unauthorised connection attempt at ${request.url}`);
            socket.close();

            return;
        }

        super.onConnection(socket, request);
    }

    /**
     * On request
     *
     * @param {Request} request
     * @param {Response} response
     */
    onRequest(request, response) {
        try {
            this.handleRequest(request, response);
        } catch (error) {
            // Fatal
            response.writeHead(500);
            response.end();

            console.error('HTTP Error: %s on %s', error.message, request.url);
        }
    }

    /**
     * Handle request
     *
     * @param {Request} request
     * @param {Response} response
     */
    handleRequest(request, response) {
        const { url, method } = request;
        const [ path ] = url.split('?');

        // CORS preflight
        if (method === 'OPTIONS') {
            response.writeHead(204, this.corsHeaders());

            return response.end();
        }

        // Upload a local file to make it replayable for the whole room
        if (method === 'POST' && this.uploadMatcher.test(path)) {
            const [ roomId ] = this.uploadMatcher.exec(path).slice(1);

            return this.handleUpload(roomId, request, response);
        }

        // Serve an uploaded file
        if (method === 'GET' && this.mediaMatcher.test(path)) {
            const [ roomId, mediaId ] = this.mediaMatcher.exec(path).slice(1);

            return this.handleMedia(roomId, mediaId, request, response);
        }

        // Home info
        if (url === '/') {
            response.writeHead(200, { 'Content-Type': 'application/json' });

            return response.end(JSON.stringify(this.getStatus()));
        }

        // Anything else
        response.writeHead(404);

        return response.end();
    }

    /**
     * Store an uploaded local file and return its replayable address
     *
     * @param {String} roomId
     * @param {Request} request
     * @param {Response} response
     */
    handleUpload(roomId, request, response) {
        const { searchParams } = new URL(request.url, 'http://localhost');
        const name = searchParams.get('name') || 'video';
        const type = searchParams.get('type') || 'application/octet-stream';
        const chunks = [];
        let size = 0;
        let answered = false;

        request.on('data', chunk => {
            size += chunk.length;

            if (size > this.maxUploadSize) {
                answered = true;
                response.writeHead(413, this.corsHeaders());
                response.end();
                request.destroy();

                return;
            }

            chunks.push(chunk);
        });

        request.on('end', () => {
            if (answered) {
                return;
            }

            const id = this.media.add(roomId, Buffer.concat(chunks), name, type);
            const url = `/media/${roomId}/${id}`;

            console.info('Uploaded file:', name, url);

            response.writeHead(200, { ...this.corsHeaders(), 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ url, name }));
        });

        request.on('error', () => {
            if (!answered) {
                answered = true;
                response.writeHead(500, this.corsHeaders());
                response.end();
            }
        });
    }

    /**
     * Serve an uploaded file (with HTTP range support for video seeking)
     *
     * @param {String} roomId
     * @param {String} mediaId
     * @param {Request} request
     * @param {Response} response
     */
    handleMedia(roomId, mediaId, request, response) {
        const media = this.media.get(roomId, mediaId);

        if (!media) {
            response.writeHead(404, this.corsHeaders());

            return response.end();
        }

        const { buffer, type } = media;
        const headers = {
            ...this.corsHeaders(),
            'Content-Type': type,
            'Accept-Ranges': 'bytes',
        };
        const range = request.headers.range;

        if (range) {
            const matches = /bytes=(\d*)-(\d*)/.exec(range);
            const start = matches && matches[1] ? parseInt(matches[1], 10) : 0;
            const end = Math.min(
                matches && matches[2] ? parseInt(matches[2], 10) : buffer.length - 1,
                buffer.length - 1
            );

            if (start >= buffer.length || end < start) {
                response.writeHead(416, { ...headers, 'Content-Range': `bytes */${buffer.length}` });

                return response.end();
            }

            response.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
                'Content-Length': end - start + 1,
            });

            return response.end(buffer.subarray(start, end + 1));
        }

        response.writeHead(200, { ...headers, 'Content-Length': buffer.length });

        return response.end(buffer);
    }

    /**
     * CORS headers (client and websocket server are served from different origins)
     *
     * @return {Object}
     */
    corsHeaders() {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Range',
        };
    }

    /**
     * @param {Client} client
     * @param {Request} request
     */
    onJoin(client, request) {
        client.on('error', this.onClientError);

        const attributes = this.joinMatcher.exec(request.url);

        // Should not happen...
        if (!attributes) {
            console.warn(`Unauthorised connection at ${request.url}`);
            client.close();

            return;
        }

        const [ id ] = attributes.slice(1);

        this.rooms.findOrCreate(id).addClient(client);

        console.info(`Client ${client.id} joined.`);
    }

    /**
     * @param {Client} client
     */
    onLeave(client) {
        console.info(`Client ${client.id} left.`);
    }

    /**
     * Netcode already logs the error and closes the socket,
     * but an 'error' event with no listener would crash the process.
     */
    onClientError() {}

    /**
     * On error
     *
     * @param {Error} error
     */
    onError(error) {
        throw error;
    }

    /**
     * Get status
     *
     * @return {Object}
     */
    getStatus() {
        return {
            rooms: this.rooms.length,
            clients: this.clients.length,
        };
    }
}
