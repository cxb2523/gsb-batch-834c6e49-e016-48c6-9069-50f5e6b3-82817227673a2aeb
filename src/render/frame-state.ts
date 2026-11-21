// The cross-frame identity of a SplatView. The view's temporal accumulation, previous-frame
// matrices, occlusion grid and projected cache are only meaningful for frames that share one
// identity: while it is unchanged the previous frame stays valid and the history accumulates
// (with its moving/resident-set weight rules), and any field change invalidates every one of
// those states together, so a frame can never read a history, a depth grid or a cache built for
// a different target, projection type, renderer session, eye count or history format.
//
// Keeping the identity in one place makes "the previous frame is valid" a verifiable invariant:
// a view's cross-frame state is valid iff its frameIdentity equals the frame about to render.
type FrameIdentity = {
    /** The target's pixel size (the warp table's while the view renders through one). */
    width: number;
    height: number;
    /** Perspective vs orthographic projection: their depth encodings differ. */
    orthographic: boolean;
    /** The renderer was attached for both frames: a disable/enable cycle starts over. */
    rendererEnabled: boolean;
    /** One image per eye of a stereo session vs the camera's own single image. */
    stereo: boolean;
    /** The TAA history colour format (unorm16 fixed point vs half floats). */
    historyHalf: boolean;
};

// two frames share an identity when every field matches
const sameFrameIdentity = (a: FrameIdentity | null, b: FrameIdentity): boolean =>
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.orthographic === b.orthographic &&
    a.rendererEnabled === b.rendererEnabled &&
    a.stereo === b.stereo &&
    a.historyHalf === b.historyHalf;

export { sameFrameIdentity };
export type { FrameIdentity };
