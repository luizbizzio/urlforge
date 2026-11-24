export function readShortcutDestination({ href, origin }, basePath = "/") {
  const prefix = origin + basePath;
  if (!href.startsWith(prefix)) return null;
  // Use the serialized URL to keep the original query, fragment, and percent escapes.
  const destination = href.slice(prefix.length);
  return /^https?:\/\//i.test(destination) ? destination : null;
}
