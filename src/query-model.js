import { SUFFIX_SYMBOLS, suffixSymbolAt } from "./suffix-context.js";

// These constants and update rules are part of the adaptive query wire format.
const ORDER = 8;
const PRIOR_PER_DISTINCT_SYMBOL = 4;
const SCALE = 16384;
const ALPHABET_SIZE = SUFFIX_SYMBOLS.length;
const PATH = 0, KEY = 1, VALUE = 2, FRAGMENT = 3;

export function adaptiveQueryResolver(resolveBase) {
  const tables = Array.from({ length: 4 }, () => new Map());
  const localMass = new Float64Array(ALPHABET_SIZE);
  const starts = new Uint16Array(ALPHABET_SIZE);
  const frequencies = new Uint16Array(ALPHABET_SIZE);
  const model = { total: SCALE, starts, frequencies, symbolAt: suffixSymbolAt };
  let history = "", section = PATH;
  const active = [];
  return previous => {
    const base = resolveBase(previous);
    const character = SUFFIX_SYMBOLS[previous];
    if (character !== undefined) {
      for (const context of active) {
        if (!context.sum) context.first = previous;
        if (context.counts || context.first !== previous) {
          context.counts ??= new Map([[context.first, context.sum]]);
          context.counts.set(previous, (context.counts.get(previous) ?? 0) + 1);
        }
        context.sum++;
      }
      history = (history + character).slice(-ORDER);
      if (character === "#") section = FRAGMENT;
      else if (section === PATH && character === "?") section = KEY;
      else if (section === VALUE && character === "&") section = KEY;
      else if (section === KEY && character === "=") section = VALUE;
    }
    const table = tables[section];
    active.length = 0;
    localMass.fill(0);
    let remaining = 1;
    // Longer matching contexts contribute first. The frozen suffix model supplies the remainder.
    for (let offset = 0; offset <= history.length; offset++) {
      const key = history.slice(offset);
      let context = table.get(key);
      if (!context) {
        context = { first: -1, counts: null, sum: 0 };
        table.set(key, context);
      } else {
        const unit = remaining / (context.sum + PRIOR_PER_DISTINCT_SYMBOL * (context.counts?.size ?? 1));
        if (context.counts) {
          for (const [symbol, count] of context.counts) localMass[symbol] += count * unit;
        } else localMass[context.first] += context.sum * unit;
        remaining -= unit * context.sum;
      }
      active.push(context);
    }
    if (remaining === 1) return base;
    let cumulative = 0, next = 0;
    for (let symbol = 0; symbol < ALPHABET_SIZE; symbol++) {
      cumulative += localMass[symbol] + remaining * base.frequencies[symbol] / base.total;
      starts[symbol] = next;
      next = symbol === ALPHABET_SIZE - 1 ? SCALE : symbol + 1 + Math.floor((SCALE - ALPHABET_SIZE) * cumulative);
      frequencies[symbol] = next - starts[symbol];
    }
    return model;
  };
}
