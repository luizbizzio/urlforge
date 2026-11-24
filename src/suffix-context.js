export const SUFFIX_SYMBOLS = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).join("") + "\0";
export const SUFFIX_END = SUFFIX_SYMBOLS.length - 1;
export const SUFFIX_HISTORY_START = "^";

export function suffixSymbolAt(value) {
  let low = 0, high = this.starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (this.starts[middle] <= value) low = middle;
    else high = middle;
  }
  return low;
}

function characterClass(char) {
  if (char >= "0" && char <= "9") return "9";
  if (char >= "a" && char <= "z") return "a";
  if (char >= "A" && char <= "Z") return "A";
  return char;
}

export function suffixContexts(previous, prior, earlier) {
  return ["", characterClass(previous), `2${characterClass(prior)}${previous}`, `3${prior}${previous}`, `4${earlier}${prior}${previous}`];
}
