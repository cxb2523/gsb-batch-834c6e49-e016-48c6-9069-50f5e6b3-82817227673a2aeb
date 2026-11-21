/**
 * Pure scroll math so it can be unit-tested without a real layout engine.
 *
 * Returns the smallest scrollTop change that keeps the item inside the
 * viewport. An item that is already visible leaves the scroll position
 * untouched, which is what "keep the current track visible" means when the
 * user is browsing the rest of the list.
 */
export const computeScrollTop = ({
  scrollTop = 0,
  viewportHeight = 0,
  itemTop = 0,
  itemHeight = 0,
  padding = 0,
} = {}) => {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return scrollTop;
  }

  if (!Number.isFinite(itemTop) || !Number.isFinite(itemHeight)) {
    return scrollTop;
  }

  const top = itemTop - padding;
  const bottom = itemTop + itemHeight + padding;

  if (top < scrollTop) {
    return Math.max(0, top);
  }

  if (bottom > scrollTop + viewportHeight) {
    return Math.max(0, bottom - viewportHeight);
  }

  return scrollTop;
};

export default computeScrollTop;
