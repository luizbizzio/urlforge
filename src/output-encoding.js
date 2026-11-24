export const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// URI-unreserved characters only. `~` increases the radix without introducing
// escaping, fragment delimiters, shell metacharacters, or Markdown delimiters.
export const SAFE_FRAGMENT_ALPHABET = `${BASE64URL_ALPHABET}~`;

export const COMPACT_FRAGMENT_MARKERS = "!$*+,/;=?@";
export const EXPANDED_FRAGMENT_MARKERS = "&':";

export function isCompactFragment(payload) {
  return typeof payload === "string" && /[!$*+,/;=?@&':]/.test(payload);
}

export function isExpandedCompactFragment(payload) {
  return /[&':]/.test(payload);
}

export const OUTPUT_ALPHABETS = Object.freeze({
  base64url: Object.freeze({ name: "base64url", alphabet: BASE64URL_ALPHABET, radix: 64, compatibility: true }),
  safe65: Object.freeze({ name: "safe65", alphabet: SAFE_FRAGMENT_ALPHABET, radix: 65, compatibility: false })
});

function resolveAlphabet(name) {
  const definition = OUTPUT_ALPHABETS[name];
  if (!definition) throw new Error(`Unknown output alphabet: ${name}`);
  return definition;
}

function encodeBase64Url(bytes) {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    output += BASE64URL_ALPHABET[(value >>> 18) & 63] + BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (i + 1 < bytes.length) output += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (i + 2 < bytes.length) output += BASE64URL_ALPHABET[value & 63];
  }
  return output;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("Invalid base64url payload");
  const output = [];
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64URL_ALPHABET.indexOf(value[i]), b = BASE64URL_ALPHABET.indexOf(value[i + 1]);
    const c = i + 2 < value.length ? BASE64URL_ALPHABET.indexOf(value[i + 2]) : 0;
    const d = i + 3 < value.length ? BASE64URL_ALPHABET.indexOf(value[i + 3]) : 0;
    const number = (a << 18) | (b << 12) | (c << 6) | d;
    output.push((number >>> 16) & 255);
    if (i + 2 < value.length) output.push((number >>> 8) & 255);
    if (i + 3 < value.length) output.push(number & 255);
  }
  return Uint8Array.from(output);
}

const BYTE_BLOCK_SIZE = 6;
const BYTE_BLOCK_BITS = 48n;
const BYTE_BLOCK_MASK = (1n << BYTE_BLOCK_BITS) - 1n;
const RADIX_BLOCK_SIZE = 8;

// Small blocks stay within the exact integer range of Number, leaving the wide operations to BigInt.
function bytesToInteger(bytes) {
  let value = 0n;
  for (let offset = 0; offset < bytes.length; offset += BYTE_BLOCK_SIZE) {
    const length = Math.min(BYTE_BLOCK_SIZE, bytes.length - offset);
    let block = 0;
    for (let i = 0; i < length; i++) block = block * 256 + bytes[offset + i];
    const shift = length === BYTE_BLOCK_SIZE ? BYTE_BLOCK_BITS : BigInt(length * 8);
    value = (value << shift) | BigInt(block);
  }
  return value;
}

function integerToBytes(value) {
  if (value < 0n) throw new Error("Invalid radix payload");
  const output = [];
  do {
    let block = Number(value & BYTE_BLOCK_MASK);
    value >>= BYTE_BLOCK_BITS;
    for (let i = 0; i < BYTE_BLOCK_SIZE && (value || block || i === 0); i++) {
      output.push(block % 256);
      block = Math.floor(block / 256);
    }
  } while (value);
  output.reverse();
  return Uint8Array.from(output);
}

export function encodeRadixInteger(value, alphabet = SAFE_FRAGMENT_ALPHABET) {
  if (value < 0n) throw new Error("Invalid radix integer");
  let output = "";
  const radix = alphabet.length;
  const blockRadix = BigInt(radix) ** BigInt(RADIX_BLOCK_SIZE);
  do {
    let block = Number(value % blockRadix);
    value /= blockRadix;
    for (let i = 0; i < RADIX_BLOCK_SIZE && (value || block || i === 0); i++) {
      output = alphabet[block % radix] + output;
      block = Math.floor(block / radix);
    }
  } while (value);
  return output;
}

export function decodeRadixInteger(payload, alphabet = SAFE_FRAGMENT_ALPHABET) {
  if (!payload) throw new Error("Empty payload");
  const radix = alphabet.length;
  const wideRadix = BigInt(radix);
  const blockRadix = wideRadix ** BigInt(RADIX_BLOCK_SIZE);
  let value = 0n;
  for (let offset = 0; offset < payload.length; offset += RADIX_BLOCK_SIZE) {
    const length = Math.min(RADIX_BLOCK_SIZE, payload.length - offset);
    let block = 0;
    for (let i = 0; i < length; i++) {
      const digit = alphabet.indexOf(payload[offset + i]);
      if (digit < 0) throw new Error("Invalid output-alphabet character");
      block = block * radix + digit;
    }
    const multiplier = length === RADIX_BLOCK_SIZE ? blockRadix : wideRadix ** BigInt(length);
    value = value * multiplier + BigInt(block);
  }
  return value;
}

export function encodeOutput(bytes, name = "base64url") {
  const { alphabet } = resolveAlphabet(name);
  return name === "base64url" ? encodeBase64Url(bytes) : encodeRadixInteger(bytesToInteger(bytes), alphabet);
}

export function decodeOutput(payload, name = "base64url") {
  const { alphabet } = resolveAlphabet(name);
  return name === "base64url" ? decodeBase64Url(payload) : integerToBytes(decodeRadixInteger(payload, alphabet));
}

export function auditOutputAlphabet(name, prefix = "http://uf.mr#") {
  const { alphabet } = resolveAlphabet(name), sample = `${alphabet}${alphabet.split("").reverse().join("")}`;
  const parsed = new URL(`${prefix}${sample}`);
  const fragment = parsed.hash.slice(1);
  return {
    name,
    radix: alphabet.length,
    excludesFragmentDelimiter: !alphabet.includes("#"),
    browserRoundTrip: fragment === sample,
    browserAddsPercentEncoding: fragment !== sample,
    decodeURIComponentRoundTrip: decodeURIComponent(sample) === sample,
    copyPasteRoundTrip: new URL(parsed.href).hash.slice(1) === sample,
    simulatedPrefixCharacters: prefix.length,
    browserCanonicalPrefixCharacters: parsed.href.length - sample.length,
    windowsTerminalUnquotedSafe: /^[A-Za-z0-9._~-]+$/.test(alphabet),
    markdownAutolinkSafe: /^[A-Za-z0-9._~-]+$/.test(alphabet),
    chatTransportSafe: /^[A-Za-z0-9._~-]+$/.test(alphabet),
    qrByteModeSafe: /^[\x20-\x7e]+$/.test(alphabet),
    qrAlphanumericModeSafe: /^[0-9A-Z $%*+\-./:]+$/.test(alphabet)
  };
}
