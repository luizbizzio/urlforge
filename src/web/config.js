export const INPUT_URL_MAX_BYTES = 8192;
export const QR_MAX_LINK_CHARACTERS = 2000;
export const CLIENT_VERSION = "0.1.0";

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeShortUrlBase(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("SHORT_URL_BASE_REQUIRES_HTTPS");
  }
  if (parsed.hash && parsed.hash !== "#") throw new Error("SHORT_URL_BASE_HAS_FRAGMENT");
  parsed.hash = "";
  return `${parsed.href}#`;
}

export function fallbackShortUrlBase(locationLike) {
  const origin = new URL(locationLike.origin);
  if (origin.protocol === "http:" && !isLoopback(origin.hostname)) origin.protocol = "https:";
  return `${origin.origin}/#`;
}

export function resolvePublicConfig(env = {}, locationLike = globalThis.location) {
  const configuredBase = env.PUBLIC_SHORT_URL_BASE?.trim();
  const shortUrlBase = configuredBase ? normalizeShortUrlBase(configuredBase) : fallbackShortUrlBase(locationLike);
  let telemetryEndpoint = null;
  const configuredEndpoint = env.TELEMETRY_ENDPOINT?.trim();
  if (configuredEndpoint) {
    try {
      const endpoint = new URL(configuredEndpoint, locationLike.href);
      if (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && isLoopback(endpoint.hostname))) telemetryEndpoint = endpoint.href;
    } catch { /* Invalid optional telemetry is treated as disabled. */ }
  }
  return Object.freeze({ shortUrlBase, telemetryEndpoint, shortUrlBaseSource: configuredBase ? "configured" : "local" });
}
