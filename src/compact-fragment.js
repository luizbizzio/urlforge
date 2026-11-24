import { COMPACT_FRAGMENT_MARKERS, SAFE_FRAGMENT_ALPHABET, decodeRadixInteger, encodeRadixInteger, isCompactFragment } from "./output-encoding.js";

// Wire format: the last digit is alphanumeric, and at least one preceding digit
// is outside the legacy alphabet. The order of these alphabets is fixed.
const LEGACY = SAFE_FRAGMENT_ALPHABET + ".";
const ALPHABET = LEGACY + COMPACT_FRAGMENT_MARKERS;
const ENDINGS = LEGACY.slice(0, 62);
const LEGACY_RADIX = BigInt(LEGACY.length);
const RADIX = BigInt(ALPHABET.length);
const END_RADIX = BigInt(ENDINGS.length);
const HAMR_RADIX = BigInt(SAFE_FRAGMENT_ALPHABET.length);
const INVALID_DIGIT = /[^A-Za-z0-9_~.!$*+,/;=?@-]/;

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

function shorterCompactPrefixes(length) {
  return shorterStrings(RADIX, length) - shorterStrings(LEGACY_RADIX, length);
}

function writeCompact(value, limit) {
  let rank = value / END_RADIX;
  if (limit < 2 || rank >= shorterCompactPrefixes(limit)) return null;
  let length = Math.min(limit - 1, estimatedDigits(rank, RADIX));
  while (length > 1 && rank < shorterCompactPrefixes(length)) length--;
  while (rank >= shorterCompactPrefixes(length + 1)) length++;
  rank -= shorterCompactPrefixes(length);
  let all = RADIX ** BigInt(length), legacy = LEGACY_RADIX ** BigInt(length);
  let marked = false, prefix = "";
  for (let i = 0; i < length; i++) {
    all /= RADIX;
    legacy /= LEGACY_RADIX;
    let block = all, offset = 0;
    if (!marked) {
      const requiringMarker = all - legacy;
      const legacyBlock = requiringMarker * LEGACY_RADIX;
      if (rank < legacyBlock) block = requiringMarker;
      else {
        rank -= legacyBlock;
        offset = LEGACY.length;
        marked = true;
      }
    }
    prefix += ALPHABET[offset + Number(rank / block)];
    rank %= block;
  }
  return prefix + ENDINGS[Number(value % END_RADIX)];
}

function readCompact(payload) {
  const length = payload.length - 1;
  let all = RADIX ** BigInt(length), legacy = LEGACY_RADIX ** BigInt(length);
  let rank = shorterCompactPrefixes(length), marked = false;
  for (let i = 0; i < length; i++) {
    all /= RADIX;
    legacy /= LEGACY_RADIX;
    const digit = ALPHABET.indexOf(payload[i]);
    if (marked) rank += BigInt(digit) * all;
    else if (digit < LEGACY.length) rank += BigInt(digit) * (all - legacy);
    else {
      rank += LEGACY_RADIX * (all - legacy) + BigInt(digit - LEGACY.length) * all;
      marked = true;
    }
  }
  return rank * END_RADIX + BigInt(ENDINGS.indexOf(payload.at(-1)));
}

export function encodeCompactFragment(payload, hamrPayload, maxLength, maxOutputLength = maxLength) {
  let limit = Math.min(payload.length - 1, maxOutputLength);
  if (limit < 2) return null;
  let result = null;
  if (payload.length <= maxLength) {
    const rank = rankPayload(payload, LEGACY, LEGACY_RADIX);
    result = writeCompact(rank << 1n, limit);
    if (result) limit = result.length - 1;
  }
  if (hamrPayload && limit >= 2) {
    // ha.mr v0 uses least-significant-digit-first bijective base65. Its fixed
    // zero version bit becomes the odd format tag, occupying the same bit.
    const rank = rankPayload([...hamrPayload].reverse().join(""), SAFE_FRAGMENT_ALPHABET, HAMR_RADIX);
    if (rank & 1n) return writeCompact(rank, limit) ?? result;
  }
  return result;
}

export function decodeCompactFragment(payload, limit) {
  if (!isCompactFragment(payload) || payload.length > limit || INVALID_DIGIT.test(payload) ||
    !/^[A-Za-z0-9]$/.test(payload.at(-1))) throw new Error("Invalid compact fragment");
  const rank = readCompact(payload);
  const plain = rank & 1n ? [...unrankPayload(rank, SAFE_FRAGMENT_ALPHABET, HAMR_RADIX)].reverse().join("") :
    unrankPayload(rank >> 1n, LEGACY, LEGACY_RADIX);
  if (plain.length > limit) throw new Error("Compact fragment exceeds decoded limit");
  return plain;
}
