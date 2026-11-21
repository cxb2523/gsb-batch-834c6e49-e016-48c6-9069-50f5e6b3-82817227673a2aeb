import {Component, ReactNode} from 'react';
import {PLAYER_LATEST} from './constant';
import {DEFAULT_RETRY_DELAY, loadIframeApi} from './tools/script';

export const NODE_JS_ID = '__kinescope_player_react_js';

export type JSLoadError = Event | Error;

type LoaderProps = {
	children: ReactNode;
	/** IFrame API script URL. Defaults to `latest`. */
	src?: string;
	onJSLoad: () => void;
	onJSLoadError?: (e: JSLoadError) => void;
};

class Loader extends Component<LoaderProps> {
	/** Bumped on every mount/unmount: results of loads started before are ignored. */
	private generation = 0;
	/** Pending automatic reload after a failed round, `null` if none. */
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	/*
	 * Loading starts in componentDidMount, not in the constructor: the constructor runs
	 * during render, before the container ref is attached (and may run twice in StrictMode
	 * or be thrown away by a concurrent render).
	 */
	componentDidMount() {
		this.generation++;
		this.load();
	}

	componentWillUnmount() {
		this.generation++;
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	/*
	 * One round of loading. A failed round is reported once through onJSLoadError and
	 * then automatically retried after a pause while the component is mounted: the
	 * players on the page recover on their own instead of waiting for a new player to
	 * mount. Rounds are shared through loadIframeApi, so a retry (or a player mounted
	 * while a retry is pending) joins the round already in flight instead of inserting
	 * another <script> tag. Results of a stale generation (unmounted or remounted)
	 * are dropped: they neither deliver callbacks nor schedule a retry.
	 */
	private load = () => {
		const generation = this.generation;
		const {src = PLAYER_LATEST} = this.props;

		loadIframeApi({src, id: NODE_JS_ID}).then(
			() => {
				generation === this.generation && this.props.onJSLoad();
			},
			(e: JSLoadError) => {
				if (generation !== this.generation) {
					return;
				}
				const {onJSLoadError} = this.props;
				onJSLoadError && onJSLoadError(e);
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					generation === this.generation && this.load();
				}, DEFAULT_RETRY_DELAY);
			},
		);
	};

	render() {
		const {children} = this.props;
		return children;
	}
}

export default Loader;
