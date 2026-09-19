// Isolated experiment retained for reproducibility. It is not imported by the codec.
const TRAINING = new TextEncoder().encode("eeeeeeeeeeeeaaaaaaaaooooooooiiiiiiiinnnnnnnnrrrrrrttttttssssssllllllccccccddddduuuummmpppggghhhbbffyyvvwwkkxxjjqqzz000000001111112222233333444445555566666777778888899999////////........--------________????&&&&====%%%%:::comhttpswwwquerysearchsourcecampaignmediumcontentgithubgoogleexamplepathpageidrefutm");
const SCALE_BITS = 12, TOTAL = 1 << SCALE_BITS, LOWER_BOUND = 1 << 23;
const source = Array(256).fill(1); for (const byte of TRAINING) source[byte]++;
const sourceTotal = source.reduce((sum, value) => sum + value, 0), frequencies = source.map(value => Math.max(1, Math.floor(value * TOTAL / sourceTotal)));
let difference = TOTAL - frequencies.reduce((sum, value) => sum + value, 0);
const order = [...Array(256).keys()].sort((a, b) => source[b] - source[a] || a - b);
for (let i = 0; difference; i = (i + 1) % order.length) { const symbol = order[i]; if (difference > 0) { frequencies[symbol]++; difference--; } else if (frequencies[symbol] > 1) { frequencies[symbol]--; difference++; } }
const starts = Array(256); let cumulative = 0; for (let i = 0; i < 256; i++) { starts[i] = cumulative; cumulative += frequencies[i]; }
const lookup = new Uint16Array(TOTAL); for (let symbol = 0; symbol < 256; symbol++) lookup.fill(symbol, starts[symbol], starts[symbol] + frequencies[symbol]);

export function encodeRans(bytes) {
  let state = LOWER_BOUND; const tail = [];
  for (let i = bytes.length - 1; i >= 0; i--) { const symbol = bytes[i], frequency = frequencies[symbol], maximum = Math.floor(LOWER_BOUND / TOTAL) * frequency * 256; while (state >= maximum) { tail.push(state & 255); state = Math.floor(state / 256); } state = Math.floor(state / frequency) * TOTAL + state % frequency + starts[symbol]; }
  return Uint8Array.from([state & 255, state >>> 8 & 255, state >>> 16 & 255, state >>> 24 & 255, ...tail.reverse()]);
}
export function decodeRans(encoded, length) {
  let state = (encoded[0] | encoded[1] << 8 | encoded[2] << 16 | encoded[3] << 24) >>> 0, index = 4; const output = new Uint8Array(length);
  for (let i = 0; i < length; i++) { const slot = state & (TOTAL - 1), symbol = lookup[slot]; output[i] = symbol; state = frequencies[symbol] * Math.floor(state / TOTAL) + slot - starts[symbol]; while (state < LOWER_BOUND && index < encoded.length) state = state * 256 + encoded[index++]; }
  if (index !== encoded.length) throw new Error("Trailing rANS data"); return output;
}
