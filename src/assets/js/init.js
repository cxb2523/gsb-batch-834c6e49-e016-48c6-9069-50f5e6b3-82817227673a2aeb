import app from "./app.js";
import jPlayerManager from "./jplayer.js";

const init = () => {
  // jPlayer manager first: it constructs the playlist, detects the initial
  // display mode and performs the first render. The app shell then binds the
  // toggles against that already-initialised view.
  jPlayerManager.init();
  app.init();
};

if (typeof document === "undefined") {
  // Non-DOM environments (unit tests) import the modules directly instead.
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export { init };
