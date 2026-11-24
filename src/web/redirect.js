import { tryDecompress } from "../url-codec.js";
import { readLinkFragment } from "./link-fragment.js";

export function resolvePayloadFragment(hash) {
  const { payload, askBeforeOpening } = readLinkFragment(hash);
  const result = tryDecompress(payload);
  if (!result.ok) return { ok: false, errorCode: result.error.code };
  return { ok: true, destination: result.value, destinationScheme: new URL(result.value).protocol.slice(0, -1), askBeforeOpening };
}
