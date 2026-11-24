// Expanded payloads reserve the first position for the confirmation marker.
export const CONFIRMATION_MARKER = ":";

export function readLinkFragment(hash) {
  const fragment = typeof hash === "string" && hash.startsWith("#") ? hash.slice(1) : hash;
  const askBeforeOpening = typeof fragment === "string" && fragment.startsWith(CONFIRMATION_MARKER);
  return { payload: askBeforeOpening ? fragment.slice(1) : fragment, askBeforeOpening };
}
