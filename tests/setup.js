// jsdom does not implement window.scrollTo and logs a "Not implemented" error
// whenever page-level scrolling is exercised. Provide a harmless stub so tests
// that depend on document scrolling stay quiet (the app itself falls back to
// setting scrollTop when scrollTo is unavailable).
if (typeof window !== "undefined") {
  window.scrollTo = () => null;
}
