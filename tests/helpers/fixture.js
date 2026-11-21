/**
 * Builds the subset of index.html the player logic depends on, so tests can
 * drive the real PlaylistView / JPlayerManager against a realistic DOM.
 */
export const createFixture = ({ display = "hide", notice = true } = {}) => {
  document.body.innerHTML = `
    <div class="playlist-toggles">
      <button class="button selected" type="button" aria-pressed="true" data-display="hide">Hide</button>
      <button class="button" type="button" aria-pressed="false" data-display="bottom">Bottom</button>
      <button class="button" type="button" aria-pressed="false" data-display="scroll">Scroll</button>
      <button class="button" type="button" aria-pressed="false" data-display="side">Side</button>
    </div>

    <div class="audio-player playlist-${display}">
      <div id="jplayer-1"></div>
      <div id="jplayer-container-1" class="jp-audio">
        <div class="jp-interface">
          <div class="track-info">
            <figure class="track-poster">
              <img id="track-poster-img" src="" alt="Track poster" />
            </figure>
            <div class="track-title"></div>
            <div class="track-artist"></div>
            <div class="track-record"></div>
          </div>
        </div>
        <div class="jp-playlist">
          <ul></ul>
        </div>
        ${notice ? '<div class="player-notice" role="status" aria-live="polite" hidden></div>' : ""}
      </div>
    </div>
  `;

  return {
    artist: document.querySelector(".track-artist"),
    jpAudio: document.querySelector(".jp-audio"),
    notice: document.querySelector(".player-notice"),
    player: document.querySelector(".audio-player"),
    playlist: document.querySelector(".jp-playlist"),
    poster: document.querySelector(".track-poster img"),
    record: document.querySelector(".track-record"),
    title: document.querySelector(".track-title"),
    toggles: [...document.querySelectorAll(".playlist-toggles button")],
  };
};

export const demoPlaylist = [
  {
    artist: "MDN",
    mp3: "https://cdn.example.com/t-rex-roar.mp3",
    poster: "poster-a.jpg",
    record: "Interactive examples (CC0)",
    title: "T-Rex Roar",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/arcade-bonus-alert.mp3",
    poster: "poster-b.jpg",
    record: "Mixkit Sound Effects Free License",
    title: "Arcade bonus alert",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/soft-ping.mp3",
    poster: "poster-c.jpg",
    record: "Mixkit Sound Effects Free License",
    title: "Soft interface ping",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/game-reward.mp3",
    poster: "poster-d.jpg",
    record: "Mixkit Sound Effects Free License",
    title: "Game reward sting",
  },
];

/**
 * jsdom has no layout engine, so getBoundingClientRect always returns zeros.
 * This installs a simple stacked layout: row i sits at i * rowHeight inside
 * the playlist, with the playlist's top at `containerTop`.
 */
export const installStackLayout = ({ container, rowHeight = 40, containerTop = 0 } = {}) => {
  const playlist = container ?? document.querySelector(".jp-playlist");

  const rectFor = (index) => ({
    bottom: containerTop + (index + 1) * rowHeight,
    height: rowHeight,
    left: 0,
    right: 200,
    top: containerTop + index * rowHeight,
    width: 200,
    x: 0,
    y: containerTop + index * rowHeight,
  });

  const originalPlaylistRect = playlist.getBoundingClientRect;
  const rowRects = new Map();

  playlist.getBoundingClientRect = () => ({
    bottom: containerTop + rowHeight * 4,
    height: rowHeight * 4,
    left: 0,
    right: 200,
    top: containerTop,
    width: 200,
    x: 0,
    y: containerTop,
  });

  const rows = () => [...playlist.querySelectorAll("li")];

  const patchRows = () => {
    for (const [index, row] of rows().entries()) {
      if (!rowRects.has(row)) {
        row.getBoundingClientRect = () => rectFor(index);
        rowRects.set(row, index);
      }
    }
  };

  patchRows();

  return {
    patchRows,
    restore() {
      playlist.getBoundingClientRect = originalPlaylistRect;
    },
  };
};
