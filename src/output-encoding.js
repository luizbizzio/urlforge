export const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// URI-unreserved characters only. `~` increases the radix without introducing
// escaping, fragment delimiters, shell metacharacters, or Markdown delimiters.
export const SAFE_FRAGMENT_ALPHABET = `${BASE64URL_ALPHABET}~`;

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

function bytesToInteger(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function integerToBytes(value) {
  if (value < 0n) throw new Error("Invalid radix payload");
  const output = [];
  do { output.push(Number(value & 255n)); value >>= 8n; } while (value);
  output.reverse();
  return Uint8Array.from(output);
}

function encodeRadix(bytes, alphabet) {
  let value = bytesToInteger(bytes), output = "";
  const radix = BigInt(alphabet.length);
  do { output = alphabet[Number(value % radix)] + output; value /= radix; } while (value);
  return output;
}

function decodeRadix(payload, alphabet) {
  if (!payload) throw new Error("Empty payload");
  const radix = BigInt(alphabet.length); let value = 0n;
  for (const character of payload) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid output-alphabet character");
    value = value * radix + BigInt(digit);
  }
  return integerToBytes(value);
}

export function encodeOutput(bytes, name = "base64url") {
  const { alphabet } = resolveAlphabet(name);
  return name === "base64url" ? encodeBase64Url(bytes) : encodeRadix(bytes, alphabet);
}

export function decodeOutput(payload, name = "base64url") {
  const { alphabet } = resolveAlphabet(name);
  return name === "base64url" ? decodeBase64Url(payload) : decodeRadix(payload, alphabet);
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
