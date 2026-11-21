// Minimal react stub: appStore only needs useSyncExternalStore at module scope.
export function useSyncExternalStore(_subscribe, getSnapshot) {
  return getSnapshot();
}
export default {};
