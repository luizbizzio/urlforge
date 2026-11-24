import { COMPACT_FRAGMENT_MARKERS, EXPANDED_FRAGMENT_MARKERS, SAFE_FRAGMENT_ALPHABET, decodeRadixInteger, encodeRadixInteger, isCompactFragment, isExpandedCompactFragment } from "./output-encoding.js";

// Each format ends in an alphanumeric digit and uses at least one new digit
// before it. The alphabet order and the rank tags are part of the wire format.
const LEGACY = SAFE_FRAGMENT_ALPHABET + ".";
const ENDINGS = LEGACY.slice(0, 62);
const LEGACY_RADIX = BigInt(LEGACY.length);
const END_RADIX = BigInt(ENDINGS.length);
const HAMR_RADIX = BigInt(SAFE_FRAGMENT_ALPHABET.length);
const INVALID_DIGIT = /[^A-Za-z0-9_~.!$*+,/;=?@&':-]/;

function makeFormat(previousAlphabet, markers) {
  const alphabet = previousAlphabet + markers;
  return { alphabet, radix: BigInt(alphabet.length), previousRadix: BigInt(previousAlphabet.length) };
}

const COMPACT = makeFormat(LEGACY, COMPACT_FRAGMENT_MARKERS);
const EXPANDED = makeFormat(COMPACT.alphabet, EXPANDED_FRAGMENT_MARKERS);

function shorterStrings(radix, length) {
  return (radix ** BigInt(length) - radix) / (radix - 1n);
}

function rankPayload(payload, alphabet, radix) {
  return shorterStrings(radix, payload.length) + decodeRadixInteger(payload, alphabet);
}

function unrankPayload(rank, alphabet, radix) {
  let length = estimatedDigits(rank, radix);
  while (length > 1 && rank < shorterStrings(radix, length)) length--;
  while (rank >= shorterStrings(radix, length + 1)) length++;
  return encodeRadixInteger(rank - shorterStrings(radix, length), alphabet).padStart(length, alphabet[0]);
}

function estimatedDigits(value, radix) {
  return Math.max(1, Math.ceil(value.toString(2).length / Math.log2(Number(radix))));
}

function shorterCompactPrefixes({ radix, previousRadix }, length) {
  return shorterStrings(radix, length) - shorterStrings(previousRadix, length);
}

function writeCompact(value, limit, format) {
  if (limit < 2) return null;
  const { alphabet, radix, previousRadix } = format;
  let rank = value / END_RADIX;
  if (rank >= shorterCompactPrefixes(format, limit)) return null;
  let length = Math.min(limit - 1, estimatedDigits(rank, radix));
  while (length > 1 && rank < shorterCompactPrefixes(format, length)) length--;
  while (rank >= shorterCompactPrefixes(format, length + 1)) length++;
  rank -= shorterCompactPrefixes(format, length);
  let all = radix ** BigInt(length), previous = previousRadix ** BigInt(length);
  let prefix = "";
  for (let i = 0; i < length; i++) {
    all /= radix;
    previous /= previousRadix;
    const block = all - previous;
    const unmarked = block * previousRadix;
    if (rank >= unmarked) {
      rank -= unmarked;
      prefix += alphabet[Number(previousRadix + rank / all)];
      const remaining = length - i - 1;
      if (remaining) {
        prefix += encodeRadixInteger(rank % all, alphabet).padStart(remaining, alphabet[0]);
      }
      break;
    }
    prefix += alphabet[Number(rank / block)];
    rank %= block;
  }
  return prefix + ENDINGS[Number(value % END_RADIX)];
}

function readCompact(payload, format) {
  const { alphabet, radix, previousRadix } = format;
  const length = payload.length - 1;
  let all = radix ** BigInt(length), previous = previousRadix ** BigInt(length);
  let rank = shorterCompactPrefixes(format, length);
  for (let i = 0; i < length; i++) {
    all /= radix;
    previous /= previousRadix;
    const digit = BigInt(alphabet.indexOf(payload[i]));
    const block = all - previous;
    if (digit >= previousRadix) {
      rank += previousRadix * block + (digit - previousRadix) * all;
      if (i + 1 < length) rank += decodeRadixInteger(payload.slice(i + 1, -1), alphabet);
      break;
    }
    rank += digit * block;
  }
  return rank * END_RADIX + BigInt(ENDINGS.indexOf(payload.at(-1)));
}

function rankExpanded(payload) {
  const prefixLength = payload.startsWith("..") ? 2 : payload.startsWith(".") ? 1 : 0;
  if (!prefixLength) return rankPayload(payload, LEGACY, LEGACY_RADIX) << 2n;
  // Restore the Forge prefix from the tag instead of packing literal dots.
  const rank = rankPayload(payload.slice(prefixLength), SAFE_FRAGMENT_ALPHABET, HAMR_RADIX);
  return (rank << 3n) | (prefixLength === 2 ? 6n : 2n);
}

function isShareableExpanded(payload) {
  // The confirmation prefix must not collide with a fragment directive. Entity
  // syntax can be decoded by Markdown or HTML link renderers.
  return !payload.startsWith(":") && !payload.startsWith("~:") && !payload.includes(":~:") && !/&[A-Za-z0-9]+;/.test(payload);
}

function encodeFragment(payload, hamrPayload, maxLength, maxOutputLength, format) {
  let limit = Math.min(payload.length - 1, maxOutputLength);
  if (limit < 2) return null;
  const expanded = format === EXPANDED;
  let result = null;
  if (payload.length <= maxLength) {
    const rank = expanded ? rankExpanded(payload) : rankPayload(payload, LEGACY, LEGACY_RADIX) << 1n;
    result = writeCompact(rank, limit, format);
    if (expanded && result && !isShareableExpanded(result)) result = null;
    if (result) limit = result.length - 1;
  }
  if (hamrPayload && hamrPayload.length <= maxLength && limit >= 2) {
    // ha.mr v0 uses least-significant-digit-first bijective base65. Its fixed
    // zero version bit becomes the odd format tag, occupying the same bit.
    const rank = rankPayload([...hamrPayload].reverse().join(""), SAFE_FRAGMENT_ALPHABET, HAMR_RADIX);
    if (rank & 1n) {
      const encoded = writeCompact(rank, limit, format);
      if (encoded && (!expanded || isShareableExpanded(encoded))) return encoded;
    }
  }
  return result;
}

export function encodeCompactFragment(payload, hamrPayload, maxLength, maxOutputLength = maxLength) {
  return encodeFragment(payload, hamrPayload, maxLength, maxOutputLength, COMPACT);
}

export function encodeExpandedCompactFragment(payload, hamrPayload, maxLength, maxOutputLength = maxLength) {
  return encodeFragment(payload, hamrPayload, maxLength, maxOutputLength, EXPANDED);
}

export function decodeCompactFragment(payload, limit) {
  if (!isCompactFragment(payload) || payload.length > limit || INVALID_DIGIT.test(payload) ||
    !/^[A-Za-z0-9]$/.test(payload.at(-1))) throw new Error("Invalid compact fragment");
  const expanded = isExpandedCompactFragment(payload);
  if (expanded && !isShareableExpanded(payload)) throw new Error("Invalid expanded fragment");
  const rank = readCompact(payload, expanded ? EXPANDED : COMPACT);
  let plain;
  if (rank & 1n) plain = [...unrankPayload(rank, SAFE_FRAGMENT_ALPHABET, HAMR_RADIX)].reverse().join("");
  else if (expanded && (rank & 2n)) {
    const prefix = rank & 4n ? ".." : ".";
    plain = prefix + unrankPayload(rank >> 3n, SAFE_FRAGMENT_ALPHABET, HAMR_RADIX);
  } else plain = unrankPayload(rank >> (expanded ? 2n : 1n), LEGACY, LEGACY_RADIX);
  if (plain.length > limit) throw new Error("Compact fragment exceeds decoded limit");
  return plain;
}
