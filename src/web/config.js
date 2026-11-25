export const INPUT_URL_MAX_BYTES = 8192;
export const QR_MAX_LINK_CHARACTERS = 2000;

const OFFICIAL_SHORT_URL_BASE = "https://uf.do/#";
const OFFICIAL_HOSTS = new Set(["uf.do", "www.uf.do", "urlforge.luizbizzio.com", "urlforge.pages.dev"]);

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
  const official = OFFICIAL_HOSTS.has(new URL(locationLike.origin).hostname);
  const shortUrlBase = configuredBase ? normalizeShortUrlBase(configuredBase) :
    official ? OFFICIAL_SHORT_URL_BASE : fallbackShortUrlBase(locationLike);
  return Object.freeze({ shortUrlBase, shortUrlBaseSource: configuredBase ? "configured" : official ? "official" : "local" });
}
