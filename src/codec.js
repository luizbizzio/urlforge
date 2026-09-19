import { BASE64URL_ALPHABET, OUTPUT_ALPHABETS, decodeOutput, encodeOutput } from "./output-encoding.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const BASE64URL = BASE64URL_ALPHABET;
const FORMAT_VERSION = 8;
const GLOBAL_STREAM_VERSION = 6;
const CURRENT_SEGMENTED_VERSION = 5;
const SUPPORTED_VERSIONS = new Set([1, 2, 3, 4, 5, 6, 7, FORMAT_VERSION]);

const DICTIONARY = [
  "www.", ".com", ".org", ".net", ".io", ".co", ".dev", ".app",
  "github", "youtube", "google", "maps.", "example", "reddit", "amazon",
  "/watch", "/search", "/users/", "/user/", "/products/", "/issues/",
  "/pull/", "/blob/", "/tree/", "/commit/", "/releases", "/actions",
  "utm_source=", "utm_medium=", "utm_campaign=", "utm_content=", "utm_term=",
  "&source=", "?q=", "&list=", "&v=", "?v=", "fbclid=", "gclid=",
  "%20", "%2F", "%3A", "index.html", "api/", "docs/", "download/",
  "https%3A", "redirect", "callback", "page=", "limit=", "offset=",
  "lang=", "locale=", "ref=", "id=", "sort=", "filter=", "format=",
  "token=", "session=", "category=", "profile", "status="
];
const DEFAULT_FEATURES = Object.freeze({ numbers: true, uuids: true, hex: true, timestamps: true, directBinaryValues: false });

// Static model trained on URL punctuation and common English URL components.
// Every byte has a non-zero fallback frequency, so arbitrary UTF-8 stays reversible.
const HUFFMAN_TRAINING = "eeeeeeeeeeeeaaaaaaaaooooooooiiiiiiiinnnnnnnnrrrrrrttttttssssssllllllccccccddddduuuummmpppggghhhbbffyyvvwwkkxxjjqqzz000000001111112222233333444445555566666777778888899999////////........--------________????&&&&====%%%%:::comhttpswwwquerysearchsourcecampaignmediumcontentgithubgoogleexamplepathpageidrefutm";

function buildHuffmanModel() {
  const frequencies = Array(256).fill(1);
  for (const byte of textEncoder.encode(HUFFMAN_TRAINING)) frequencies[byte]++;
  let serial = 0;
  const queue = frequencies.map((frequency, symbol) => ({ frequency, symbol, min: symbol, serial: serial++ }));
  const sort = () => queue.sort((a, b) => a.frequency - b.frequency || a.min - b.min || a.serial - b.serial);
  while (queue.length > 1) { sort(); const left = queue.shift(), right = queue.shift(); queue.push({ frequency: left.frequency + right.frequency, min: Math.min(left.min, right.min), serial: serial++, left, right }); }
  const root = queue[0], codes = Array(256);
  const visit = (node, bits = "") => { if (node.symbol !== undefined) { codes[node.symbol] = bits || "0"; return; } visit(node.left, bits + "0"); visit(node.right, bits + "1"); };
  visit(root);
  return { frequencies, codes, root };
}
const HUFFMAN = buildHuffmanModel();

function buildStatisticalModel(source = HUFFMAN.frequencies) {
  const scaleBits = 12, total = 1 << scaleBits, sourceTotal = source.reduce((sum, value) => sum + value, 0);
  const frequencies = source.map(value => Math.max(1, Math.floor(value * total / sourceTotal)));
  let difference = total - frequencies.reduce((sum, value) => sum + value, 0);
  const order = [...Array(256).keys()].sort((a, b) => source[b] - source[a] || a - b);
  for (let i = 0; difference; i = (i + 1) % order.length) { const symbol = order[i]; if (difference > 0) { frequencies[symbol]++; difference--; } else if (frequencies[symbol] > 1) { frequencies[symbol]--; difference++; } }
  const starts = Array(256); let cumulative = 0;
  for (let i = 0; i < 256; i++) { starts[i] = cumulative; cumulative += frequencies[i]; }
  const lookup = new Uint16Array(total); for (let symbol = 0; symbol < 256; symbol++) lookup.fill(symbol, starts[symbol], starts[symbol] + frequencies[symbol]);
  return { scaleBits, total, frequencies, starts, lookup };
}
const STATISTICAL = buildStatisticalModel();

const CONTEXT_TRAINING = Object.freeze({
  hostname: "www.example.com api.github.com assets.cdn.net images.service.io alpha.beta.internal.dev maps.google.com video.example.org xn--r8jz45g.xn--zckzah 127.0.0.1",
  path: "/api/v1/users/123/profile /docs/getting-started/index.html /assets/images/logo.svg /repository/commit/releases/download/archive /products/category/item",
  query: "?q=search&lang=en&utm_source=web&utm_medium=link&id=123&page=1&limit=20&token=abcdef&redirect=https%3A%2F%2Fexample.com%2Fpath",
  fragment: "#section #overview #installation #results #comments #heading-2 #details"
});
const CONTEXT_MODEL_NAMES = Object.freeze(["hostname", "path", "query", "fragment"]);

function buildContextModels(training) {
  const bytes = textEncoder.encode(training), order0Source = Array(256).fill(1), transitionSources = new Map();
  let previous = 256;
  for (const symbol of bytes) {
    order0Source[symbol]++;
    const frequencies = transitionSources.get(previous) || Array(256).fill(1); frequencies[symbol] += 8; transitionSources.set(previous, frequencies);
    previous = symbol;
  }
  const order0 = buildStatisticalModel(order0Source), order1 = new Map();
  for (const [context, frequencies] of transitionSources) order1.set(context, buildStatisticalModel(frequencies));
  return { order0, order1 };
}
const CONTEXT_MODELS = Object.freeze(Object.fromEntries(Object.entries(CONTEXT_TRAINING).map(([name, training]) => [name, buildContextModels(training)])));

const AC_MAX = 0xffffffffn, AC_HALF = 0x80000000n, AC_QUARTER = 0x40000000n, AC_THREE_QUARTERS = 0xc0000000n;
function encodeArithmeticWithResolver(bytes, resolveModel) {
  let low = 0n, high = AC_MAX, pending = 0; const bits = [];
  const emit = bit => { bits.push(bit); while (pending--) bits.push(bit ^ 1); pending = 0; };
  let previous = 256;
  for (const symbol of bytes) {
    const model = resolveModel(previous), range = high - low + 1n, start = BigInt(model.starts[symbol]), frequency = BigInt(model.frequencies[symbol]);
    high = low + range * (start + frequency) / BigInt(model.total) - 1n; low += range * start / BigInt(model.total);
    for (;;) {
      if (high < AC_HALF) emit(0); else if (low >= AC_HALF) { emit(1); low -= AC_HALF; high -= AC_HALF; }
      else if (low >= AC_QUARTER && high < AC_THREE_QUARTERS) { pending++; low -= AC_QUARTER; high -= AC_QUARTER; } else break;
      low <<= 1n; high = (high << 1n) + 1n;
    }
    previous = symbol;
  }
  pending++; emit(low < AC_QUARTER ? 0 : 1); return bits;
}
function decodeArithmeticWithResolver(bits, length, resolveModel) {
  let low = 0n, high = AC_MAX, code = 0n, index = 0; const next = () => index < bits.length ? BigInt(bits[index++]) : 0n;
  for (let i = 0; i < 32; i++) code = (code << 1n) | next();
  const output = new Uint8Array(length); let previous = 256;
  for (let position = 0; position < length; position++) {
    const model = resolveModel(previous), range = high - low + 1n, scaled = Number(((code - low + 1n) * BigInt(model.total) - 1n) / range), symbol = model.lookup[scaled]; output[position] = symbol;
    const start = BigInt(model.starts[symbol]), frequency = BigInt(model.frequencies[symbol]); high = low + range * (start + frequency) / BigInt(model.total) - 1n; low += range * start / BigInt(model.total);
    for (;;) {
      if (high < AC_HALF) { /* no offset */ } else if (low >= AC_HALF) { code -= AC_HALF; low -= AC_HALF; high -= AC_HALF; }
      else if (low >= AC_QUARTER && high < AC_THREE_QUARTERS) { code -= AC_QUARTER; low -= AC_QUARTER; high -= AC_QUARTER; } else break;
      low <<= 1n; high = (high << 1n) + 1n; code = (code << 1n) | next();
    }
    previous = symbol;
  }
  return output;
}
function encodeArithmetic(bytes) { return encodeArithmeticWithResolver(bytes, () => STATISTICAL); }
function decodeArithmetic(bits, length) { return decodeArithmeticWithResolver(bits, length, () => STATISTICAL); }
function contextModel(name, order, previous) {
  const models = CONTEXT_MODELS[name]; if (!models) throw new Error("Invalid context model");
  return order === 0 ? models.order0 : models.order1.get(previous) || models.order0;
}
function encodeContextArithmetic(bytes, name, order) { return encodeArithmeticWithResolver(bytes, previous => contextModel(name, order, previous)); }
function decodeContextArithmetic(bits, length, name, order) { return decodeArithmeticWithResolver(bits, length, previous => contextModel(name, order, previous)); }

const COMMON_HOSTS = ["example.com", "x.com", "github.com", "google.com", "www.youtube.com", "www.google.com", "maps.google.com", "shop.example.com", "api.example.com", "docs.example.com", "xn--r8jz45g.xn--zckzah", "reddit.com", "amazon.com"];
const COMMON_LABELS = ["com", "org", "net", "io", "co", "dev", "app", "www", "github", "google", "youtube", "maps", "example", "shop", "api", "docs", "reddit", "amazon", "xn--r8jz45g", "xn--zckzah"];
const HOST_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-";

class BitWriter {
  constructor() { this.bytes = []; this.current = 0; this.used = 0; this.bitLength = 0; this.featureCounts = {}; }
  write(value, count) {
    const n = BigInt(value);
    for (let i = count - 1; i >= 0; i--) {
      this.current = (this.current << 1) | Number((n >> BigInt(i)) & 1n); this.used++; this.bitLength++;
      if (this.used === 8) { this.bytes.push(this.current); this.current = 0; this.used = 0; }
    }
  }
  append(other) { const length = other.bitLength, bytes = other.finish(); for (let i = 0; i < length; i++) this.write((bytes[i >> 3] >> (7 - (i & 7))) & 1, 1); for (const [name, count] of Object.entries(other.featureCounts)) this.featureCounts[name] = (this.featureCounts[name] || 0) + count; }
  mark(name) { this.featureCounts[name] = (this.featureCounts[name] || 0) + 1; }
  finish() { if (this.used) this.bytes.push(this.current << (8 - this.used)); return Uint8Array.from(this.bytes); }
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.index = 0; }
  read(count) {
    if (this.index + count > this.bytes.length * 8) throw new Error("Unexpected end of payload");
    let value = 0n;
    for (let i = 0; i < count; i++, this.index++) value = (value << 1n) | BigInt((this.bytes[this.index >> 3] >> (7 - (this.index & 7))) & 1);
    return value;
  }
  readNumber(count) { return Number(this.read(count)); }
}

function writeVarUint(writer, value) {
  const n = BigInt(value); const code = n + 1n; const bits = code.toString(2).length;
  for (let i = 1; i < bits; i++) writer.write(0, 1);
  writer.write(code, bits);
}
function readVarUint(reader) {
  let zeros = 0;
  while (reader.readNumber(1) === 0) { if (++zeros > 256) throw new Error("Invalid variable integer"); }
  return ((1n << BigInt(zeros)) | (zeros ? reader.read(zeros) : 0n)) - 1n;
}

function writeFormatHeader(writer, version, secure) {
  if (version <= 7) writer.write(version, 3);
  else { writer.write(0, 3); writeVarUint(writer, version - 8); }
  writer.write(secure ? 1 : 0, 1);
}

function readFormatHeader(reader) {
  const compact = reader.readNumber(3);
  const version = compact || 8 + Number(readVarUint(reader));
  if (!Number.isSafeInteger(version) || !SUPPORTED_VERSIONS.has(version)) throw new Error(`Unsupported payload version: ${version}`);
  return { version, secure: reader.readNumber(1) === 1 };
}

function matchAt(value, index, features) {
  let best = null;
  const consider = candidate => { if (!best || candidate.saving > best.saving || (candidate.saving === best.saving && candidate.length > best.length)) best = candidate; };
  for (let i = 0; i < DICTIONARY.length; i++) {
    const token = DICTIONARY[i];
    if (value.startsWith(token, index)) consider({ type: "dictionary", index: i, length: token.length, saving: textEncoder.encode(token).length * 8 - 8 });
  }
  const tail = value.slice(index);
  if (features.directBinaryValues) {
    const hexMatch = tail.match(/^[0-9a-fA-F]{8,64}/);
    if (hexMatch && /[a-fA-F]/.test(hexMatch[0]) && (hexMatch[0] === hexMatch[0].toLowerCase() || hexMatch[0] === hexMatch[0].toUpperCase())) {
      const text = hexMatch[0], cost = 11 + varUintBitCost(text.length - 1) + text.length * 4;
      consider({ type: "directHex", text, length: text.length, saving: textEncoder.encode(text).length * 8 - cost });
    }
    const base64Match = tail.match(/^[A-Za-z0-9_-]{12,}/);
    if (base64Match && /[A-Z]/.test(base64Match[0]) && /[0-9_-]/.test(base64Match[0])) {
      const text = base64Match[0], cost = 10 + varUintBitCost(text.length - 1) + text.length * 6;
      consider({ type: "directBase64", text, length: text.length, saving: textEncoder.encode(text).length * 8 - cost });
    }
  }
  if (features.uuids) { const m = tail.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/); if (m) consider({ type: "uuid", text: m[0], length: 36, saving: 154 }); }
  if (features.timestamps) { const m = tail.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/); if (m) { const seconds = Date.parse(m[0]) / 1000; if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds < 2 ** 34) consider({ type: "timestamp", value: BigInt(seconds), length: 20, saving: 121 }); } }
  if (features.hex) { const m = tail.match(/^[0-9a-fA-F]{8,64}/); if (m && /[a-fA-F]/.test(m[0])) { const text = m[0], saving = text.length * 3 - 11; if (saving > 0) consider({ type: "hex", text, length: text.length, saving }); } }
  if (features.numbers) { const m = tail.match(/^\d{2,}/); if (m && m[0].length <= 32) { const text = m[0], number = BigInt(text), bits = (number + 1n).toString(2).length, saving = text.length * 8 - (10 + bits * 2 - 1); if (saving > 0) consider({ type: "number", text, value: number, length: text.length, saving }); } }
  return best;
}

function writeToken(writer, m) {
  if (m.type === "dictionary") { writer.write(0b10, 2); writer.write(m.index, 6); return; }
  if (m.type === "number") { writer.write(0b11000, 5); writer.write(m.text.length - 1, 5); writeVarUint(writer, m.value); return; }
  if (m.type === "uuid") { writer.write(0b11001, 5); writer.write(BigInt(`0x${m.text.replaceAll("-", "")}`), 128); return; }
  if (m.type === "hex") { writer.write(0b11010, 5); writer.write(m.text.length - 1, 6); for (const c of m.text) { writer.write(parseInt(c, 16), 4); writer.write(c >= "A" && c <= "F" ? 1 : 0, 1); } return; }
  if (m.type === "timestamp") { writer.write(0b11011, 5); writer.write(m.value, 34); return; }
  if (m.type === "directHex") { writeExtendedPrefix(writer, 6); writer.write(0, 2); writeVarUint(writer, m.text.length - 1); writer.write(m.text === m.text.toUpperCase() ? 1 : 0, 1); for (const char of m.text) writer.write(parseInt(char, 16), 4); writer.mark("directBinaryValues"); return; }
  if (m.type === "directBase64") { writeExtendedPrefix(writer, 6); writer.write(1, 2); writeVarUint(writer, m.text.length - 1); for (const char of m.text) writer.write(BASE64URL.indexOf(char), 6); writer.mark("directBinaryValues"); return; }
  throw new Error(`Unknown token ${m.type}`);
}
function tokenBitCost(match) {
  if (match.type === "dictionary") return 8;
  if (match.type === "number") return 10 + varUintBitCost(match.value);
  if (match.type === "uuid") return 133;
  if (match.type === "hex") return 11 + match.text.length * 5;
  if (match.type === "timestamp") return 39;
  if (match.type === "directHex") return 11 + varUintBitCost(match.text.length - 1) + match.text.length * 4;
  if (match.type === "directBase64") return 10 + varUintBitCost(match.text.length - 1) + match.text.length * 6;
  return Infinity;
}
function varUintBitCost(value) { return (BigInt(value) + 1n).toString(2).length * 2 - 1; }

function buildLzMatchTable(history, bytes) {
  const combined = Uint8Array.from([...history, ...bytes]), historyLength = history.length, positions = new Map(), table = Array.from({ length: bytes.length }, () => []);
  const keyAt = index => index + 2 < combined.length ? (combined[index] << 16) | (combined[index + 1] << 8) | combined[index + 2] : -1;
  const add = index => { const key = keyAt(index); if (key < 0) return; const list = positions.get(key) || []; list.push(index); positions.set(key, list); };
  for (let index = 0; index < historyLength; index++) add(index);
  for (let position = 0; position < bytes.length; position++) {
    const target = historyLength + position, key = keyAt(target), prior = key < 0 ? [] : positions.get(key) || [];
    const eligible = prior.filter(source => target - source <= 16384), sampled = eligible.length <= 10 ? eligible : [...eligible.slice(-6), eligible[0], eligible[Math.floor(eligible.length / 4)], eligible[Math.floor(eligible.length / 2)], eligible[Math.floor(eligible.length * 3 / 4)]];
    const matches = [];
    for (const source of new Set(sampled)) { let length = 0; while (length < 1024 && position + length < bytes.length && combined[source + length] === combined[target + length]) length++; const distance = target - source; if (length >= 3) matches.push({ distance, length, metadata: varUintBitCost(distance - 1) }); }
    matches.sort((a, b) => b.length - a.length || a.metadata - b.metadata || a.distance - b.distance);
    table[position] = matches.filter((match, index) => !matches.slice(0, index).some(other => other.length >= match.length && other.metadata <= match.metadata)); add(target);
  }
  return table;
}

function writeExtendedPrefix(writer, subtype) { writer.write(0b11110, 5); writer.write(subtype, 3); }

function structuredHostWriter(url) {
  const writer = new BitWriter(), commonIndex = COMMON_HOSTS.indexOf(url.hostname);
  writeExtendedPrefix(writer, 0);
  if (commonIndex >= 0) { writer.write(0, 1); writer.write(commonIndex, 4); }
  else {
    const labels = url.hostname.split(".");
    if (labels.length < 1 || labels.length > 4) return null;
    writer.write(1, 1); writer.write(labels.length - 1, 2);
    for (const label of labels) {
      const index = COMMON_LABELS.indexOf(label);
      if (index >= 0) { writer.write(1, 1); writer.write(index, 5); continue; }
      if (!label || label.length > 63 || [...label].some(char => !HOST_ALPHABET.includes(char))) return null;
      writer.write(0, 1); writer.write(label.length - 1, 6);
      for (const char of label) writer.write(HOST_ALPHABET.indexOf(char), 6);
    }
  }
  writer.write(url.port ? 1 : 0, 1); if (url.port) writeVarUint(writer, Number(url.port));
  return writer;
}

function specialBodyWriter(url, structural) {
  const body = `${url.host}${url.pathname}${url.search}${url.hash}`;
  if (structural.youtube && !url.port && !url.hash) {
    const match = body.match(/^www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})(?:&list=([A-Za-z0-9_-]{1,63}))?$/);
    if (match) { const writer = new BitWriter(); writeExtendedPrefix(writer, 3); for (const char of match[1]) writer.write(BASE64URL.indexOf(char), 6); writer.write(match[2] ? 1 : 0, 1); if (match[2]) { writer.write(match[2].length - 1, 6); for (const char of match[2]) writer.write(BASE64URL.indexOf(char), 6); } return writer; }
  }
  if (structural.maps && !url.port && !url.hash) {
    const match = body.match(/^maps\.google\.com\/\?q=(-?\d{1,2}\.\d{6}),(-?(?:\d{1,2}|1[0-7]\d)\.\d{6})&z=(\d{1,2})$/);
    if (match) { const latitude = Math.round(Number(match[1]) * 1e6), longitude = Math.round(Number(match[2]) * 1e6), zoom = Number(match[3]); if (latitude >= -90000000 && latitude <= 90000000 && longitude >= -180000000 && longitude <= 180000000 && zoom >= 0 && zoom < 32) { const writer = new BitWriter(); writeExtendedPrefix(writer, 4); writer.write(latitude + 90000000, 28); writer.write(longitude + 180000000, 29); writer.write(zoom, 5); return writer; } }
  }
  if (structural.short && !url.port && !url.search && !url.hash) {
    const host = COMMON_HOSTS.indexOf(url.hostname), path = url.pathname === "/" ? "" : url.pathname.startsWith("/") ? url.pathname.slice(1) : null;
    if (host >= 0 && path !== null && path.length <= 15 && [...path].every(char => BASE64URL.includes(char))) { const writer = new BitWriter(); writeExtendedPrefix(writer, 2); writer.write(host, 4); writer.write(path.length, 4); for (const char of path) writer.write(BASE64URL.indexOf(char), 6); return writer; }
  }
  return null;
}

function writeLiteral(writer, text, methods, history, segmentType = "path") {
  const bytes = textEncoder.encode(text), length = bytes.length;
  const lzTable = methods.lz ? buildLzMatchTable(history, bytes) : null;
  const dp = Array(length + 1).fill(Infinity), choices = Array(length); dp[length] = 0;
  for (let position = length - 1; position >= 0; position--) {
    const limit = Math.min(32, length - position); let huffmanBits = 0;
    for (let size = 1; size <= limit; size++) {
      const byte = bytes[position + size - 1];
      const rawCost = 6 + size * 8 + dp[position + size];
      if (rawCost < dp[position]) { dp[position] = rawCost; choices[position] = { type: "raw", length: size }; }
      huffmanBits += HUFFMAN.codes[byte].length;
      if (methods.huffman) {
        const cost = 10 + huffmanBits + dp[position + size];
        if (cost < dp[position]) { dp[position] = cost; choices[position] = { type: "huffman", length: size }; }
      }
    }
    const statisticalSizes = position % 4 === 0 ? [...new Set([32, 128, 512, ...(position === 0 ? [length] : [])])].filter(size => size <= length - position) : [];
    for (const size of statisticalSizes) {
      const chunk = bytes.slice(position, position + size);
      if (methods.arithmetic) { const bits = encodeArithmetic(chunk), cost = 8 + varUintBitCost(size) + varUintBitCost(bits.length) + bits.length + dp[position + size]; if (cost < dp[position]) { dp[position] = cost; choices[position] = { type: "arithmetic", length: size, bits }; } }
      if (methods.contextArithmetic) for (const order of [0, 1]) {
        const bits = encodeContextArithmetic(chunk, segmentType, order), cost = 11 + varUintBitCost(size) + varUintBitCost(bits.length) + bits.length + dp[position + size];
        if (cost < dp[position]) { dp[position] = cost; choices[position] = { type: "contextArithmetic", length: size, bits, segmentType, order }; }
      }
    }
    if (methods.lz) {
      for (const match of lzTable[position]) {
        const sizes = [...new Set([...Array.from({ length: Math.min(match.length, 32) - 2 }, (_, i) => i + 3), 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, match.length])].filter(size => size <= match.length);
        for (const size of sizes) { const cost = 5 + match.metadata + varUintBitCost(size - 3) + dp[position + size]; if (cost < dp[position]) { dp[position] = cost; choices[position] = { type: "lz", length: size, distance: match.distance }; } }
      }
    }
  }
  for (let position = 0; position < length;) {
    const choice = choices[position]; if (!choice) throw new Error("Literal planner failed");
    const chunk = bytes.slice(position, position + choice.length);
    if (choice.type === "raw") { writer.write(0, 1); writer.write(choice.length - 1, 5); for (const byte of chunk) writer.write(byte, 8); }
    else if (choice.type === "huffman") { writer.write(0b11100, 5); writer.write(choice.length - 1, 5); for (const byte of chunk) for (const bit of HUFFMAN.codes[byte]) writer.write(bit === "1" ? 1 : 0, 1); }
    else if (choice.type === "lz") { writer.write(0b11101, 5); writeVarUint(writer, choice.distance - 1); writeVarUint(writer, choice.length - 3); }
    else if (choice.type === "arithmetic") { writeExtendedPrefix(writer, 5); writeVarUint(writer, choice.length); writeVarUint(writer, choice.bits.length); for (const bit of choice.bits) writer.write(bit, 1); }
    else if (choice.type === "contextArithmetic") { writeExtendedPrefix(writer, 7); writer.write(CONTEXT_MODEL_NAMES.indexOf(choice.segmentType), 2); writer.write(choice.order, 1); writeVarUint(writer, choice.length); writeVarUint(writer, choice.bits.length); for (const bit of choice.bits) writer.write(bit, 1); writer.mark(`contextArithmeticOrder${choice.order}`); }
    history.push(...chunk); position += choice.length;
  }
}
function encodeSegment(writer, value, features, methods, segmentType = "path", sharedHistory = null) {
  const history = sharedHistory || [];
  let index = 0, literal = "";
  const flush = () => { if (literal) { writeLiteral(writer, literal, methods, history, segmentType); literal = ""; } };
  while (index < value.length) {
    const match = matchAt(value, index, features);
    if (match) {
      flush();
      const matchBytes = textEncoder.encode(value.slice(index, index + match.length));
      const lz = methods.lz ? buildLzMatchTable(history, textEncoder.encode(value.slice(index)))[0][0] : null;
      const lzCost = lz && matchBytes.length >= 3 && lz.length >= matchBytes.length ? 5 + varUintBitCost(lz.distance - 1) + varUintBitCost(matchBytes.length - 3) : Infinity;
      if (lzCost < tokenBitCost(match)) { writer.write(0b11101, 5); writeVarUint(writer, lz.distance - 1); writeVarUint(writer, matchBytes.length - 3); }
      else writeToken(writer, match);
      history.push(...matchBytes); index += match.length;
    }
    else {
      const char = String.fromCodePoint(value.codePointAt(index));
      literal += char; index += char.length;
    }
  }
  flush();
}

function encodeNormalBody(url, features, methods, structural) {
  const writer = new BitWriter(), rawHost = new BitWriter();
  encodeSegment(rawHost, url.host, features, methods, "hostname");
  const compactHost = structural.hostname ? structuredHostWriter(url) : null;
  writer.append(compactHost && compactHost.bitLength < rawHost.bitLength ? compactHost : rawHost);
  encodeSegment(writer, url.pathname, features, methods, "path");
  encodeSegment(writer, url.search, features, methods, "query");
  encodeSegment(writer, url.hash, features, methods, "fragment");
  return writer;
}

function encodeGlobalRawBody(url, features, methods) {
  const writer = new BitWriter();
  if (methods.contextArithmetic) {
    const history = [];
    encodeSegment(writer, url.host, features, methods, "hostname", history);
    encodeSegment(writer, url.pathname, features, methods, "path", history);
    encodeSegment(writer, url.search, features, methods, "query", history);
    encodeSegment(writer, url.hash, features, methods, "fragment", history);
  } else encodeSegment(writer, `${url.host}${url.pathname}${url.search}${url.hash}`, features, methods);
  return writer;
}

function encodeQueryOneBlockBody(url, features, methods, structural) {
  const writer = new BitWriter(), rawHost = new BitWriter(); encodeSegment(rawHost, url.host, features, methods, "hostname");
  const compactHost = structural.hostname ? structuredHostWriter(url) : null; writer.append(compactHost && compactHost.bitLength < rawHost.bitLength ? compactHost : rawHost);
  encodeSegment(writer, url.pathname, features, methods, "path"); if (url.search) writeLiteral(writer, url.search, methods, [], "query"); encodeSegment(writer, url.hash, features, methods, "fragment"); return writer;
}

function bodyCandidates(url, features, methods, structural, options) {
  const normal = encodeNormalBody(url, features, methods, structural), special = specialBodyWriter(url, structural);
  const local = special && special.bitLength < normal.bitLength ? special : normal;
  const alternatives = [{ writer: local, name: "localSegmented" }], global = options.globalRawStream ? encodeGlobalRawBody(url, features, methods) : null;
  if (global) alternatives.push({ writer: global, name: "globalRawStream" });
  if (options.queryOneBlock) alternatives.push({ writer: encodeQueryOneBlockBody(url, features, methods, structural), name: "queryAsOneBlock" });
  const choice = alternatives.reduce((best, candidate) => candidate.writer.bitLength < best.writer.bitLength ? candidate : best);
  return { local, global, candidateList: alternatives, selected: choice.writer, selectedRepresentation: choice.name, alternatives: Object.fromEntries(alternatives.map(item => [item.name, item.writer.bitLength])) };
}

function readHostnameV2Core(reader) {
  if (reader.readNumber(1)) return Array.from({ length: 4 }, () => reader.readNumber(8)).join(".");
  const count = Number(readVarUint(reader)) + 1; if (!Number.isSafeInteger(count) || count < 1 || count > 127) throw new Error("Malformed hostname label count");
  const labels = [];
  for (let labelIndex = 0; labelIndex < count; labelIndex++) {
    const mode = reader.readNumber(2); let label = "";
    if (mode === 0) { const index = reader.readNumber(5); label = COMMON_LABELS[index]; if (!label) throw new Error("Invalid hostname v2 common label"); }
    else {
      const length = Number(readVarUint(reader)) + 1; if (!Number.isSafeInteger(length) || length < 1 || length > 63) throw new Error("Malformed hostname label length");
      if (mode === 1) { for (let i = 0; i < length; i++) { const index = reader.readNumber(6); if (!HOST_ALPHABET[index]) throw new Error("Invalid hostname v2 character"); label += HOST_ALPHABET[index]; } }
      else if (mode === 2) { for (let i = 0; i < length; i++) { let node = HUFFMAN.root; while (node.symbol === undefined) node = reader.readNumber(1) ? node.right : node.left; label += String.fromCharCode(node.symbol); } }
      else { const number = readVarUint(reader).toString(); if (number.length > length) throw new Error("Invalid numeric hostname label"); label = number.padStart(length, "0"); }
    }
    labels.push(label);
  }
  return labels.join(".");
}

function readBody(reader, version, limits = {}) {
  const maxOutputBytes = Number.isSafeInteger(limits.maxOutputBytes) ? limits.maxOutputBytes : Infinity;
  const maxTokens = Number.isSafeInteger(limits.maxTokens) ? limits.maxTokens : Infinity;
  const maxBackReferenceLength = Number.isSafeInteger(limits.maxBackReferenceLength) ? limits.maxBackReferenceLength : 65535;
  const maxBackReferences = Number.isSafeInteger(limits.maxBackReferences) ? limits.maxBackReferences : Infinity;
  const output = [];
  let tokenCount = 0, backReferenceCount = 0;
  const reserve = length => {
    if (!Number.isSafeInteger(length) || length < 0 || output.length + length > maxOutputBytes) throw new Error("Decoded output limit exceeded");
  };
  const appendBytes = bytes => { reserve(bytes.length); for (const byte of bytes) output.push(byte); };
  const appendText = value => appendBytes(textEncoder.encode(value));
  for (;;) {
    if (++tokenCount > maxTokens) throw new Error("Decode token limit exceeded");
    if (reader.readNumber(1) === 0) { const length = reader.readNumber(5) + 1; reserve(length); for (let i = 0; i < length; i++) output.push(reader.readNumber(8)); continue; }
    if (reader.readNumber(1) === 0) { const index = reader.readNumber(6); if (!DICTIONARY[index]) throw new Error("Invalid dictionary token"); appendText(DICTIONARY[index]); continue; }
    const type = reader.readNumber(3);
    if (type === 0) { const digits = reader.readNumber(5) + 1, number = readVarUint(reader).toString(); if (number.length > digits) throw new Error("Invalid numeric token"); appendText(number.padStart(digits, "0")); }
    else if (type === 1) { const hex = reader.read(128).toString(16).padStart(32, "0"); appendText(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`); }
    else if (type === 2) { let hex = ""; const length = reader.readNumber(6) + 1; for (let i = 0; i < length; i++) { let c = reader.readNumber(4).toString(16); if (reader.readNumber(1) && c >= "a") c = c.toUpperCase(); hex += c; } appendText(hex); }
    else if (type === 3) appendText(new Date(Number(reader.read(34)) * 1000).toISOString().replace(".000Z", "Z"));
    else if (type === 4) {
      const length = reader.readNumber(5) + 1, bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) { let node = HUFFMAN.root; while (node.symbol === undefined) node = reader.readNumber(1) ? node.right : node.left; bytes[i] = node.symbol; }
      appendBytes(bytes);
    }
    else if (type === 5) {
      if (version < 3) throw new Error("LZ token is not valid in this format version");
      if (++backReferenceCount > maxBackReferences) throw new Error("Decode back-reference limit exceeded");
      const distance = Number(readVarUint(reader)) + 1, length = Number(readVarUint(reader)) + 3;
      if (!Number.isSafeInteger(distance) || !Number.isSafeInteger(length) || distance > output.length || length > maxBackReferenceLength) throw new Error("Malformed LZ back-reference");
      reserve(length);
      for (let i = 0; i < length; i++) output.push(output[output.length - distance]);
    } else if (type === 6) {
      if (version < 4) throw new Error("Extended token is not valid in this format version");
      const subtype = reader.readNumber(3);
      if (subtype === 0) {
        let hostname;
        if (reader.readNumber(1) === 0) { const index = reader.readNumber(4); hostname = COMMON_HOSTS[index]; if (!hostname) throw new Error("Invalid common hostname"); }
        else {
          const count = reader.readNumber(2) + 1, labels = [];
          for (let labelIndex = 0; labelIndex < count; labelIndex++) {
            if (reader.readNumber(1)) { const index = reader.readNumber(5); if (!COMMON_LABELS[index]) throw new Error("Invalid hostname label"); labels.push(COMMON_LABELS[index]); }
            else { const length = reader.readNumber(6) + 1; let label = ""; for (let i = 0; i < length; i++) { const index = reader.readNumber(6); if (!HOST_ALPHABET[index]) throw new Error("Invalid hostname character"); label += HOST_ALPHABET[index]; } labels.push(label); }
          }
          hostname = labels.join(".");
        }
        appendText(hostname); if (reader.readNumber(1)) appendText(`:${readVarUint(reader)}`);
      } else if (subtype === 1) {
        if (version < 7) throw new Error("Hostname v2 token is not valid in this format version");
        appendText(readHostnameV2Core(reader)); if (reader.readNumber(1)) appendText(`:${readVarUint(reader)}`);
      } else if (subtype === 2) {
        const host = COMMON_HOSTS[reader.readNumber(4)], length = reader.readNumber(4); if (!host) throw new Error("Invalid short URL host"); let path = ""; for (let i = 0; i < length; i++) path += BASE64URL[reader.readNumber(6)]; appendText(`${host}/${path}`);
      } else if (subtype === 3) {
        let video = ""; for (let i = 0; i < 11; i++) video += BASE64URL[reader.readNumber(6)]; let body = `www.youtube.com/watch?v=${video}`;
        if (reader.readNumber(1)) { const length = reader.readNumber(6) + 1; let list = ""; for (let i = 0; i < length; i++) list += BASE64URL[reader.readNumber(6)]; body += `&list=${list}`; } appendText(body);
      } else if (subtype === 4) {
        const latitude = reader.readNumber(28) - 90000000, longitude = reader.readNumber(29) - 180000000, zoom = reader.readNumber(5);
        const coordinate = value => `${value < 0 ? "-" : ""}${(Math.abs(value) / 1e6).toFixed(6)}`; appendText(`maps.google.com/?q=${coordinate(latitude)},${coordinate(longitude)}&z=${zoom}`);
      } else if (subtype === 5) {
        if (version < 5) throw new Error("Arithmetic token is not valid in this format version");
        const length = Number(readVarUint(reader)), bitLength = Number(readVarUint(reader)); if (!Number.isSafeInteger(length) || !Number.isSafeInteger(bitLength) || length < 1 || length > 65535 || bitLength < 1 || bitLength > 1000000) throw new Error("Malformed arithmetic block");
        reserve(length); const bits = Array.from({ length: bitLength }, () => reader.readNumber(1)); appendBytes(decodeArithmetic(bits, length));
      } else if (subtype === 6) {
        if (version < 7) throw new Error("Direct binary token is not valid in this format version");
        const kind = reader.readNumber(2), length = Number(readVarUint(reader)) + 1; if (!Number.isSafeInteger(length) || length < 1 || length > 65535) throw new Error("Malformed direct binary length");
        reserve(length);
        if (kind === 0) { const uppercase = reader.readNumber(1); let value = ""; for (let i = 0; i < length; i++) value += reader.readNumber(4).toString(16); appendText(uppercase ? value.toUpperCase() : value); }
        else if (kind === 1) { let value = ""; for (let i = 0; i < length; i++) value += BASE64URL[reader.readNumber(6)]; appendText(value); }
        else throw new Error("Reserved direct binary kind");
      } else if (subtype === 7) {
        if (version < 7) throw new Error("Extended subtype 7 is not valid in this format version");
        if (version === 7) {
          let hostname; if (reader.readNumber(1)) { hostname = COMMON_HOSTS[reader.readNumber(4)]; if (!hostname) throw new Error("Invalid short URL v2 host"); } else hostname = readHostnameV2Core(reader);
          const length = reader.readNumber(5); let path = ""; for (let i = 0; i < length; i++) path += BASE64URL[reader.readNumber(6)]; appendText(`${hostname}/${path}`);
        } else {
          const modelIndex = reader.readNumber(2), order = reader.readNumber(1), length = Number(readVarUint(reader)), bitLength = Number(readVarUint(reader));
          if (!CONTEXT_MODEL_NAMES[modelIndex] || !Number.isSafeInteger(length) || !Number.isSafeInteger(bitLength) || length < 1 || length > 65535 || bitLength < 1 || bitLength > 1000000) throw new Error("Malformed context arithmetic block");
          reserve(length); const bits = Array.from({ length: bitLength }, () => reader.readNumber(1)); appendBytes(decodeContextArithmetic(bits, length, CONTEXT_MODEL_NAMES[modelIndex], order));
        }
      } else throw new Error("Reserved extended token subtype");
    } else if (type === 7) return textDecoder.decode(Uint8Array.from(output));
  }
}

export function compressDetailed(input, options = {}) {
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (url.username || url.password) throw new Error("Credentials are not supported");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  const writer = new BitWriter(), features = { ...DEFAULT_FEATURES, ...(options.features || {}), directBinaryValues: options.directBinaryValues ?? options.features?.directBinaryValues ?? false };
  const methods = { huffman: options.huffman ?? true, lz: options.lz ?? true, arithmetic: options.arithmetic ?? true, contextArithmetic: options.contextArithmetic === true };
  const structural = options.structural === false ? { hostname: false, short: false, youtube: false, maps: false } : { hostname: true, short: true, youtube: true, maps: true, ...(options.structural || {}) };
  const candidateOptions = { globalRawStream: options.globalRawStream === true, queryOneBlock: options.queryOneBlock === true };
  const candidates = bodyCandidates(url, features, methods, structural, candidateOptions);
  let baselineBodyBits = Math.min(candidates.local.bitLength, candidates.global?.bitLength ?? Infinity);
  if (features.directBinaryValues) {
    const baselineFeatures = { ...features, directBinaryValues: false };
    const baseline = bodyCandidates(url, baselineFeatures, methods, structural, { globalRawStream: candidateOptions.globalRawStream, queryOneBlock: false });
    candidates.alternatives.directBinaryBaseline = baseline.selected.bitLength;
    candidates.candidateList.push(...baseline.candidateList.map(candidate => ({ ...candidate, name: `${candidate.name}WithoutDirectBinary` })));
    if (baseline.selected.bitLength <= candidates.selected.bitLength) { candidates.selected = baseline.selected; candidates.selectedRepresentation = baseline.selectedRepresentation; }
    candidates.local = baseline.local;
    baselineBodyBits = baseline.selected.bitLength;
  }
  const usesV8 = methods.contextArithmetic;
  const usesV7 = features.directBinaryValues;
  const version = usesV8 ? FORMAT_VERSION : usesV7 ? 7 : candidateOptions.globalRawStream || candidateOptions.queryOneBlock ? GLOBAL_STREAM_VERSION : CURRENT_SEGMENTED_VERSION;
  const requestedAlphabet = options.outputAlphabet ?? "base64url";
  const alphabetNames = requestedAlphabet === "best" ? Object.keys(OUTPUT_ALPHABETS) : [requestedAlphabet];
  const finalized = [];
  for (const candidate of candidates.candidateList) for (const outputAlphabet of alphabetNames) {
    const complete = new BitWriter(); writeFormatHeader(complete, version, url.protocol === "https:"); complete.append(candidate.writer); complete.write(0b11111, 5);
    const bytes = complete.finish(), payload = encodeOutput(bytes, outputAlphabet);
    finalized.push({ ...candidate, complete, bytes, payload, outputAlphabet });
  }
  const selected = finalized.reduce((best, candidate) => candidate.payload.length < best.payload.length || candidate.payload.length === best.payload.length && candidate.complete.bitLength < best.complete.bitLength ? candidate : best);
  candidates.selected = selected.writer; candidates.selectedRepresentation = selected.name.replace(/WithoutDirectBinary$/, "");
  const payload = selected.payload;
  const selectedFeatures = { ...candidates.selected.featureCounts };
  if (candidates.selectedRepresentation !== "localSegmented" && candidates.selectedRepresentation !== "globalRawStream") selectedFeatures[candidates.selectedRepresentation] = (selectedFeatures[candidates.selectedRepresentation] || 0) + 1;
  return { payload, outputAlphabet: selected.outputAlphabet, bitLength: selected.complete.bitLength, plan: { version, outputAlphabet: selected.outputAlphabet, payloadCharacters: payload.length, bitLength: selected.complete.bitLength, selectedRepresentation: candidates.selectedRepresentation, selectedFeatures, alternativeBodyBits: candidates.alternatives, fixedFramingBits: version > 7 ? 12 : 9, localSegmentedBodyBits: candidates.local.bitLength, globalRawStreamBodyBits: candidates.global?.bitLength ?? null, baselineBodyBits, selectedBodyBits: candidates.selected.bitLength, savedBodyBits: candidates.local.bitLength - candidates.selected.bitLength, savedVsBaselineBits: baselineBodyBits - candidates.selected.bitLength } };
}
export function compress(input, options = {}) { return compressDetailed(input, options).payload; }
export function compressCombinedDetailed(input, options = {}) {
  const outputAlphabet = options.outputAlphabet ?? "best";
  const shared = { huffman: true, lz: true, arithmetic: true, structural: options.structural, outputAlphabet };
  const variants = [
    ["v5SegmentedFallback", { ...shared, globalRawStream: false }],
    ["v6GlobalArithmetic", { ...shared, globalRawStream: true }],
    ["v6QueryOneBlock", { ...shared, globalRawStream: true, queryOneBlock: true }],
    ["v7DirectBinary", { ...shared, globalRawStream: true, queryOneBlock: true, directBinaryValues: true }]
  ];
  if (options.contextArithmetic === true) variants.push(["v8ContextArithmetic", { ...shared, globalRawStream: true, queryOneBlock: true, directBinaryValues: true, contextArithmetic: true }]);
  const measured = variants.map(([name, variantOptions]) => ({ name, detail: compressDetailed(input, variantOptions) })).filter(({ name, detail }) => name !== "v8ContextArithmetic" || (detail.plan.selectedFeatures.contextArithmeticOrder0 || 0) + (detail.plan.selectedFeatures.contextArithmeticOrder1 || 0) > 0);
  const selected = measured.reduce((best, candidate) => candidate.detail.payload.length < best.detail.payload.length || candidate.detail.payload.length === best.detail.payload.length && candidate.detail.bitLength < best.detail.bitLength ? candidate : best);
  return {
    ...selected.detail,
    combinedCandidate: selected.name,
    alternatives: Object.fromEntries(measured.map(({ name, detail }) => [name, { payloadCharacters: detail.payload.length, bitLength: detail.bitLength, outputAlphabet: detail.outputAlphabet, representation: detail.plan.selectedRepresentation }]))
  };
}
export function compressCombined(input, options = {}) { return compressCombinedDetailed(input, options).payload; }
export function decompress(payload, options = {}) {
  const reader = new BitReader(decodeOutput(payload, options.outputAlphabet ?? "base64url")), header = readFormatHeader(reader);
  return `${header.secure ? "https" : "http"}://${readBody(reader, header.version, options.limits)}`;
}
export function describe(input, payload, domain = "x.co") {
  const decoded = decompress(payload), originalLength = input.length;
  return { input, originalLength, payloadLength: payload.length, fullLinkLength: `https://${domain}/#${payload}`.length, compressionRatio: payload.length / originalLength, decoded, roundTrip: decoded === new URL(input.includes("://") ? input : `https://${input}`).href };
}
export const internals = Object.freeze({ FORMAT_VERSION, GLOBAL_STREAM_VERSION, CURRENT_SEGMENTED_VERSION, SUPPORTED_VERSIONS: [...SUPPORTED_VERSIONS], DICTIONARY, DEFAULT_FEATURES, HUFFMAN_FREQUENCIES: HUFFMAN.frequencies, encodeArithmetic, decodeArithmetic, encodeContextArithmetic, decodeContextArithmetic });
