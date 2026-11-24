import { decodeArithmeticWithResolver, encodeArithmeticWithResolver } from "./codec.js";
import { decodeOutput, encodeOutput } from "./output-encoding.js";
import { SUFFIX_END, SUFFIX_HISTORY_START, SUFFIX_SYMBOLS, suffixContexts, suffixSymbolAt } from "./suffix-context.js";
import { SUFFIX_MODEL_V1 } from "./suffix-model-v1.js";
import { adaptiveQueryResolver } from "./query-model.js";

export const MAX_SUFFIX_CHARACTERS = 2048;
const MODEL_SCALE = 4096;
const BACKOFF_WEIGHT = 32;
const models = new Map();
// A bounded cache shared by the fixed, adaptive and identifier encoders. The key
// contains all three context characters; a slot collision only evicts an entry.
const recentKeys = new Int32Array(8192).fill(-1);
const recentModels = new Array(recentKeys.length);
let contextCounts;

function readContextCounts() {
  const bytes = decodeOutput(SUFFIX_MODEL_V1);
  const contexts = new Map();
  let position = 0;
  while (position < bytes.length) {
    const length = bytes[position++];
    const key = String.fromCharCode(...bytes.subarray(position, position + length));
    position += length;
    const entries = bytes[position++];
    const frequencies = new Uint32Array(SUFFIX_SYMBOLS.length);
    let sum = 0;
    for (let i = 0; i < entries; i++) {
      const symbol = bytes[position++];
      let count = 0, shift = 0, byte;
      do {
        byte = bytes[position++];
        count += (byte & 127) * 2 ** shift;
        shift += 7;
      } while (byte >= 128);
      frequencies[symbol] = count;
      sum += count;
    }
    contexts.set(key, { frequencies, sum });
  }
  return contexts;
}

function buildModel(keys) {
  const starts = new Uint16Array(SUFFIX_SYMBOLS.length);
  const frequencies = new Uint16Array(SUFFIX_SYMBOLS.length);
  const counts = keys.map(key => contextCounts.get(key)).filter(Boolean);
  let cumulative = 0, next = 0;
  for (let i = 0; i < frequencies.length; i++) {
    let probability = 1 / frequencies.length;
    for (const context of counts) {
      probability = (context.frequencies[i] + probability * BACKOFF_WEIGHT) / (context.sum + BACKOFF_WEIGHT);
    }
    cumulative += probability;
    starts[i] = next;
    next = i === frequencies.length - 1 ? MODEL_SCALE : i + 1 + Math.floor((MODEL_SCALE - frequencies.length) * cumulative);
    frequencies[i] = next - starts[i];
  }
  return { total: MODEL_SCALE, starts, frequencies, symbolAt: suffixSymbolAt };
}

function resolver() {
  contextCounts ??= readContextCounts();
  const start = SUFFIX_HISTORY_START.charCodeAt(0);
  let history = (start << 7) | start;
  return previousSymbol => {
    const previous = SUFFIX_SYMBOLS[previousSymbol] ?? SUFFIX_HISTORY_START;
    const triple = (history << 7) | previous.charCodeAt(0);
    history = triple & 0x3fff;
    const slot = Math.imul(triple, 0x9e3779b1) >>> 19;
    if (recentKeys[slot] === triple) return recentModels[slot];
    const keys = suffixContexts(previous, String.fromCharCode((triple >>> 7) & 127), String.fromCharCode(triple >>> 14));
    const key = keys.findLast(key => contextCounts.has(key));
    if (!models.has(key)) models.set(key, buildModel(keys));
    const model = models.get(key);
    recentKeys[slot] = triple;
    recentModels[slot] = model;
    return model;
  };
}

function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil((bits.length + 1) / 8));
  const start = 8 * bytes.length - bits.length - 1;
  // The leading one keeps any zero bits in the arithmetic stream when converting to base65.
  bytes[0] = 128 >> start;
  for (let i = 0; i < bits.length; i++) {
    const position = start + i + 1;
    bytes[position >> 3] |= bits[i] << (7 - position % 8);
  }
  return encodeOutput(bytes, "safe65");
}

function unpackBits(payload) {
  if (payload[0] === "A") throw new Error("Unexpected leading zero digit");
  const bytes = decodeOutput(payload, "safe65");
  if (!bytes[0]) throw new Error("Missing suffix bit marker");
  const start = Math.clz32(bytes[0]) - 23;
  const bits = new Uint8Array(bytes.length * 8 - start);
  for (let i = 0; i < bits.length; i++) {
    const position = start + i;
    bits[i] = (bytes[position >> 3] >> (7 - position % 8)) & 1;
  }
  return bits;
}

export function encodeSuffix(tail, adaptive = false, minLength = 8) {
  if (tail.length < minLength || tail.length > MAX_SUFFIX_CHARACTERS || !/^[\x21-\x7E]+$/.test(tail)) return null;
  const input = new Uint8Array(tail.length + 1);
  for (let i = 0; i < tail.length; i++) input[i] = tail.charCodeAt(i) - 33;
  input[tail.length] = SUFFIX_END;
  const resolve = resolver();
  return packBits(encodeArithmeticWithResolver(input, adaptive ? adaptiveQueryResolver(resolve) : resolve));
}

export function decodeSuffix(payload, adaptive = false, minLength = 8) {
  const resolve = resolver();
  const bytes = decodeArithmeticWithResolver(unpackBits(payload), MAX_SUFFIX_CHARACTERS + 1, adaptive ? adaptiveQueryResolver(resolve) : resolve, SUFFIX_END);
  const tail = String.fromCharCode(...bytes.map(symbol => symbol + 33));
  if (tail.length < minLength) throw new Error("Invalid suffix bitstream");
  return tail;
}
