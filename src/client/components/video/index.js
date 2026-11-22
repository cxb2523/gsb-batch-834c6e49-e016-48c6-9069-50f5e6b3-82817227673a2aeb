import { connect } from 'react-redux';
import { setLoaded, setAuthorized, setAvailable, setDuration, setName, end } from '@client/store/player';
import VideoComponent from '@client/components/video/Video';
import YoutubeVideoComponent from '@client/components/video/YoutubeVideo';

export default function Wrapper(Component) {
    return connect(
        state => ({
            src: state.player.url,
            playing: state.player.playing,
            time: state.player.time,
            authorized: state.player.authorized,
            available: state.player.available,
            loaded: state.player.loaded,
            volume: state.options.volume,
        }),
        dispatch => ({
            setDuration: duration => dispatch(setDuration(duration)),
            setLoaded: loaded => dispatch(setLoaded(loaded)),
            setAuthorized: authorized => dispatch(setAuthorized(authorized)),
            setAvailable: available => dispatch(setAvailable(available)),
            setName: name => dispatch(setName(name)),
            end: () => dispatch(end()),
        }),
        null,
        { forwardRef: true }
    )(Component);
}

export const Video = Wrapper(VideoComponent);
export const YoutubeVideo = Wrapper(YoutubeVideoComponent);
