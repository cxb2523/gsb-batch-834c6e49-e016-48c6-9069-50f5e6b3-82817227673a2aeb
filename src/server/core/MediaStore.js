/**
 * In-memory store for uploaded local files.
 *
 * Local files only exist in the sender's browser, so the uploader pushes the
 * file to the server once; the server then keeps a replayable address that is
 * shared with the room, allowing late joiners to load the same content.
 */
export default class MediaStore {
    constructor() {
        this.rooms = new Map();
        this.nextId = 0;
    }

    /**
     * Store a file for the given room
     *
     * @param {String} roomId
     * @param {Buffer} buffer
     * @param {String} name
     * @param {String} type
     *
     * @return {String} Media id
     */
    add(roomId, buffer, name, type) {
        const id = `${(++this.nextId).toString(36)}-${Date.now().toString(36)}`;

        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Map());
        }

        this.rooms.get(roomId).set(id, { buffer, name, type });

        return id;
    }

    /**
     * Get a stored file
     *
     * @param {String} roomId
     * @param {String} id
     *
     * @return {Object|null}
     */
    get(roomId, id) {
        const room = this.rooms.get(roomId);

        return room ? room.get(id) || null : null;
    }

    /**
     * Drop all files of a room
     *
     * @param {String} roomId
     */
    deleteRoom(roomId) {
        this.rooms.delete(roomId);
    }
}
