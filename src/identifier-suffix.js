import { decodeRadixInteger, encodeRadixInteger } from "./output-encoding.js";
import { decodeSuffix, encodeSuffix, MAX_SUFFIX_CHARACTERS } from "./suffix-codec.js";

const MAX_TOKEN_CHARACTERS = 512;
const MAX_TOKENS = 64;
const DECIMAL = 0, HEX_LOWER = 1, HEX_UPPER = 2, UUID_LOWER = 3, UUID_UPPER = 4, ESCAPED_LOWER = 5, ESCAPED_UPPER = 6;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const RUNS = /(?:%[\da-fA-F]{2}){2,}|[A-Za-z0-9_-]{4,}/g;
const UNICODE_RUNS = /(?:%[\da-fA-F]{2}){2,}(?:[_-](?:%[\da-fA-F]{2}){2,})*/g;
const UNICODE = 7;
const WORD_SEPARATORS = "_- ";

function encodeUnicodeToken(text) {
  if (text.length > MAX_TOKEN_CHARACTERS) return null;
  let decoded;
  try { decoded = decodeURIComponent(text); } catch { return null; }
  const upper = encodeURIComponent(decoded);
  const lower = upper !== text;
  if (lower && upper.toLowerCase() !== text) return null;
  let min = 0x110000, max = -1;
  for (const char of decoded) {
    if (WORD_SEPARATORS.includes(char)) continue;
    const cp = char.codePointAt(0);
    if (cp < 128) return null;
    min = Math.min(min, cp);
    max = Math.max(max, cp);
  }
  if (max < min) return null;
  // Store the common high bits once and reserve digits for word separators.
  const width = 32 - Math.clz32(min ^ max);
  const size = 2 ** width, radix = BigInt(size + WORD_SEPARATORS.length);
  const page = min >>> width;
  let data = 1n;
  for (const char of decoded) {
    const separator = WORD_SEPARATORS.indexOf(char);
    const digit = separator < 0 ? char.codePointAt(0) % size : size + separator;
    data = data * radix + BigInt(digit);
  }
  data = (data << BigInt(21 - width)) | BigInt(page);
  return encodeRadixInteger((data << 9n) | BigInt(width * 16 + Number(lower) * 8 + UNICODE));
}

function decodeUnicodeToken(packed, code) {
  const width = Number((packed >> 4n) & 31n);
  if (width > 21) throw new Error("Invalid Unicode width");
  const size = 2 ** width, radix = BigInt(size + WORD_SEPARATORS.length), pageBits = BigInt(21 - width);
  const base = Number((packed >> 9n) & ((1n << pageBits) - 1n)) * size;
  let data = packed >> (9n + pageBits), length = 0;
  const pieces = [];
  while (data > 1n) {
    const digit = Number(data % radix);
    data /= radix;
    const char = digit < size ? String.fromCodePoint(base + digit) : WORD_SEPARATORS[digit - size];
    const part = encodeURIComponent(char);
    length += part.length;
    if (length > MAX_TOKEN_CHARACTERS) throw new Error("Unicode run exceeds length limit");
    pieces.push(part);
  }
  let text = pieces.reverse().join("");
  if (packed & 8n) text = text.toLowerCase();
  if (data !== 1n || encodeUnicodeToken(text) !== code) throw new Error("Invalid Unicode identifier");
  return text;
}

function encodeToken(text) {
  if (text.length < 4 || text.length > MAX_TOKEN_CHARACTERS) return null;
  let kind, digits = text;
  if (/^\d+$/.test(text)) {
    kind = DECIMAL;
  } else {
    if (text.startsWith("%")) {
      digits = text.replaceAll("%", "");
      kind = ESCAPED_LOWER;
    } else if (UUID.test(text)) {
      digits = text.replaceAll("-", "");
      kind = UUID_LOWER;
    } else if (/^[\da-f]+$/i.test(text)) {
      kind = HEX_LOWER;
    } else {
      // This run already uses the wire alphabet. Preserve its characters verbatim.
      return /[A-Z]/.test(text) && /[\d_-]/.test(text) ? "A" + text : null;
    }
    if (digits !== digits.toLowerCase()) {
      if (digits !== digits.toUpperCase()) return null;
      kind++;
    }
  }
  // A leading one preserves every leading zero and the original digit count.
  const number = kind === DECIMAL ? BigInt("1" + digits) : BigInt("0x1" + digits);
  return encodeRadixInteger((number << 3n) | BigInt(kind));
}

function decodeToken(code) {
  if (code.length > MAX_TOKEN_CHARACTERS + 1) throw new Error("Identifier length limit exceeded");
  if (code.startsWith("A")) {
    const text = code.slice(1);
    if (!/^[A-Za-z0-9_-]+$/.test(text) || encodeToken(text) !== code) throw new Error("Invalid literal identifier");
    return text;
  }
  const packed = decodeRadixInteger(code);
  const kind = Number(packed & 7n);
  if (kind === UNICODE) return decodeUnicodeToken(packed, code);
  const marked = (packed >> 3n).toString(kind === DECIMAL ? 10 : 16);
  if (kind > ESCAPED_UPPER || marked[0] !== "1") throw new Error("Invalid identifier tag");
  let text = marked.slice(1);
  if (kind === HEX_UPPER || kind === UUID_UPPER || kind === ESCAPED_UPPER) text = text.toUpperCase();
  if (kind === UUID_LOWER || kind === UUID_UPPER) {
    if (text.length !== 32) throw new Error("Invalid UUID length");
    text = [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)].join("-");
  } else if (kind === ESCAPED_LOWER || kind === ESCAPED_UPPER) {
    if (text.length % 2) throw new Error("Incomplete escaped byte");
    text = text.replace(/../g, "%$&");
  }
  if (encodeToken(text) !== code) throw new Error("Invalid packed identifier");
  return text;
}

export function encodeIdentifierSuffix(tail, unicode = false) {
  // '<' is percent-escaped in serialized HTTP paths, queries and fragments.
  if (tail.length > MAX_SUFFIX_CHARACTERS || tail.includes("<")) return null;
  const fields = [];
  let skeleton = "", offset = 0;
  for (const match of tail.matchAll(unicode ? UNICODE_RUNS : RUNS)) {
    const code = unicode ? encodeUnicodeToken(match[0]) : encodeToken(match[0]);
    if (!code) continue;
    if (fields.length === MAX_TOKENS) return null;
    fields.push(code);
    skeleton += tail.slice(offset, match.index).replaceAll("0", "<") + "0";
    offset = match.index + match[0].length;
  }
  if (!fields.length) return null;
  skeleton += tail.slice(offset).replaceAll("0", "<");
  const shape = skeleton === "0" ? "A" : encodeSuffix(skeleton, false, 1);
  return shape ? [shape, ...fields].join(".") : null;
}

export function decodeIdentifierSuffix(shape, fields) {
  if (!fields.length || fields.length > MAX_TOKENS) throw new Error("Invalid identifier count");
  const skeleton = shape === "A" ? "0" : decodeSuffix(shape, false, 1);
  if (shape !== "A" && skeleton === "0") throw new Error("Invalid identifier skeleton");
  const pieces = skeleton.split("0");
  if (pieces.length !== fields.length + 1) throw new Error("Unmatched identifier placeholder");
  let tail = pieces[0].replaceAll("<", "0");
  for (const [i, code] of fields.entries()) {
    tail += decodeToken(code) + pieces[i + 1].replaceAll("<", "0");
    if (tail.length > MAX_SUFFIX_CHARACTERS) throw new Error("Suffix length limit exceeded");
  }
  return tail;
}
