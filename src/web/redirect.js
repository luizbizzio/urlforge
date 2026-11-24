import { tryDecompress } from "../url-codec.js";

export function resolvePayloadFragment(hash) {
  const payload = typeof hash === "string" && hash.startsWith("#") ? hash.slice(1) : hash;
  const result = tryDecompress(payload);
  if (!result.ok) return { ok: false, errorCode: result.error.code };
  return { ok: true, destination: result.value, destinationScheme: new URL(result.value).protocol.slice(0, -1) };
}
