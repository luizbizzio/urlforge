function rng(seed) { return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function helpers(seed) {
  const random = rng(seed), chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const text = length => Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join("");
  const hex = length => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
  const pick = values => values[Math.floor(random() * values.length)];
  return { random, text, hex, pick };
}

export function buildHoldoutDataset(perCategory = 50) {
  const { random, text, hex, pick } = helpers(0x484f4c44), rows = [];
  const add = (category, factory) => { for (let i = 0; i < perCategory; i++) rows.push({ category, url: factory(i) }); };
  add("unknown domains", i => `https://${text(9).toLowerCase()}.${pick(["museum", "technology", "travel", "cloud", "xyz", "ai"])}/${text(8)}?x=${i}`);
  add("random long paths", () => `https://${text(10).toLowerCase()}.technology/${Array.from({ length: 12 }, () => text(18)).join("/")}`);
  add("random query parameters", () => `https://${text(8).toLowerCase()}.cloud/search?${Array.from({ length: 10 }, () => `${text(9)}=${text(22)}`).join("&")}`);
  add("long Unicode", i => `https://münchen.example/${encodeURIComponent(`${pick(["東京", "Ελλάδα", "россия", "한국", "العربية"])}-${"ação-café-🚀-".repeat(10)}${i}`)}?texto=${encodeURIComponent("mañana straße 日本語 ".repeat(6))}`);
  add("unusual TLDs", i => `https://service-${i}.${pick(["photography", "international", "solutions", "engineering", "academy"])}/catalog/${text(12)}`);
  add("nested subdomains", i => `https://${text(5).toLowerCase()}.${text(6).toLowerCase()}.region-${i % 8}.service.${pick(["museum", "travel", "cloud"])}/v2/${text(14)}`);
  add("mixed casing", i => `HTTPS://MiXeD-${i}.Example.COM/CaseSensitive/${text(10).toUpperCase()}?Key=VaLuE${i}#Section${i}`);
  add("repeated paths", i => `https://repeat-${i}.xyz/${(`${text(6).toLowerCase()}-segment/`).repeat(14)}`);
  add("non-repeated paths", () => `https://${text(8).toLowerCase()}.ai/${Array.from({ length: 15 }, () => text(13)).join("/")}`);
  add("YouTube-like nonstandard", i => pick([`https://youtu.be/${text(11)}?feature=share&t=${i}`, `https://m.youtube.com/watch?list=PL${text(12)}&v=${text(11)}`, `https://www.youtube.com/shorts/${text(11)}?si=${text(8)}`, `https://www.youtube.com/watch?feature=share&v=${text(11)}&t=${i}`]));
  add("Maps-like nonstandard", i => pick([`https://www.google.com/maps/@${(30 + random() * 20).toFixed(5)},${(-20 + random() * 40).toFixed(5)},${10 + i % 8}z`, `https://maps.google.com/?z=${10 + i % 8}&q=${(40 + random()).toFixed(4)},${(-5 + random()).toFixed(4)}&layer=traffic`, `https://maps.example.net/location?lat=${(40 + random()).toFixed(7)}&lon=${(-5 + random()).toFixed(7)}`]));
  add("short holdout", i => `https://${pick(["go.xyz", "lnk.ai", "s.travel", "u.cloud"])}/${text(1 + i % 5)}`);
  add("ports", i => `${i % 2 ? "http" : "https"}://${text(7).toLowerCase()}.dev:${8000 + i}/${text(8)}?port=${8000 + i}`);
  add("duplicates and empty values", i => `https://${text(7).toLowerCase()}.com/form?empty=&same=${i}&same=&flag&same=${i}#result`);
  add("percent encoded", i => `https://${text(7).toLowerCase()}.org/redirect/${i}?next=https%3A%2F%2Funknown.example%2Fa%2Fb%3Fx%3D1%26y%3D${i}&label=a%20b%2Bc`);
  add("holdout fragments", i => `https://${text(8).toLowerCase()}.net/${text(14)}#${text(12)}-${encodeURIComponent(" seção 東京 ")}-${i}`);
  add("unexpected UUID positions", i => `https://${hex(8)}.uuid-tracker.xyz/?550e8400-e29b-41d4-a716-446655440000=${i}#id-${hex(32)}`);
  add("unexpected hash positions", i => `https://${hex(12)}.hashes.cloud/${hex(40)}/name/${text(8)}?${hex(24)}=${hex(48)}#${hex(16)}`);
  return rows;
}

export function buildStressDataset(perCategory = 8) {
  const { text, hex } = helpers(0x53545253), valid = [], malformed = [];
  const add = (category, factory) => { for (let i = 0; i < perCategory; i++) valid.push({ category, url: factory(i) }); };
  add("very long URLs", i => `https://long-${i}.example/${text(1800)}?payload=${text(1800)}#${text(600)}`);
  add("high entropy", i => `https://${text(30).toLowerCase()}.xyz/${text(900)}?${text(30)}=${text(900)}&${text(30)}=${hex(700)}#${text(400)}`);
  add("LZ overlap", i => `https://overlap-${i}.example/${"abcde".repeat(800)}?q=${"xyz".repeat(700)}`);
  add("LZ distance boundary", i => `https://distance-${i}.example/${"start-marker-".repeat(20)}${text(1200)}${"start-marker-".repeat(20)}`);
  add("LZ beyond window", i => `https://window-${i}.example/BEGIN-${text(4300)}-BEGIN-${"tail".repeat(100)}`);
  add("long Unicode stress", i => `https://例え.テスト/${encodeURIComponent("東京🚀café-ação-".repeat(250))}?q=${encodeURIComponent("العربية 한국 Ελλάδα ".repeat(150))}&i=${i}`);
  add("unusual valid syntax", i => `http://[2001:db8::${i + 1}]:${9000 + i}/${text(80)};matrix=${i}?flag&empty=#fragment`);
  add("many duplicate parameters", i => `https://duplicates-${i}.example/path?${Array.from({ length: 250 }, (_, n) => `value=${n % 5 ? "same" : ""}`).join("&")}`);
  add("maximum semantic mixtures", i => `https://mix-${i}.example/${"550e8400-e29b-41d4-a716-446655440000/".repeat(40)}${hex(64)}?at=2026-09-19T12:34:56Z&id=${"1234567890".repeat(20)}#${hex(64)}`);
  const malformedInputs = ["", "://missing", "http://[::1", "https://host:99999/path", "https://exa mple.com/path", "ftp://example.com/file", "mailto:user@example.com", "https://user:pass@example.com/path", "http://", "https://[not-ip]/"];
  for (let i = 0; i < malformedInputs.length; i++) malformed.push({ category: "malformed inputs", url: malformedInputs[i], expected: "reject" });
  return { valid, malformed };
}

export function buildUnseenDataset(perCategory = 40) {
  const { random, text, hex, pick } = helpers(0x554e5345), rows = [];
  const add = (category, factory) => { for (let i = 0; i < perCategory; i++) rows.push({ category, url: factory(i) }); };
  add("CDN assets", i => `https://${pick(["cdn", "static", "assets"])}-${i % 7}.${text(7).toLowerCase()}.network/images/${hex(16)}/${text(20)}.${pick(["webp", "avif", "woff2", "js", "css"])}?width=${320 + i}&quality=${70 + i % 25}`);
  add("REST APIs", i => `https://api-${i % 9}.${text(8).toLowerCase()}.services/v${1 + i % 4}/organizations/${100000 + i}/resources/${text(18)}?include=owner,history&cursor=${text(32)}`);
  add("signed URLs", i => `https://${text(9).toLowerCase()}.storage.cloud/${text(20)}/${text(30)}?X-Signature=${hex(64)}&X-Expires=${1700000000 + i}&X-Credential=${text(24)}`);
  add("ecommerce filters", i => `https://shop-${i % 5}.${text(8).toLowerCase()}.market/products?brand=${text(8)}&color=${pick(["black", "white", "blue", "green"])}&size=${pick(["xs", "small", "medium", "large"])}&price_min=${i}&price_max=${1000 + i}&sort=popular&page=${1 + i % 20}`);
  add("international domains", i => `https://${pick(["例え.テスト", "münchen.example", "παράδειγμα.δοκιμή", "مثال.إختبار"])}/${encodeURIComponent(`${pick(["каталог", "produits", "商品", "منتجات"])}-${i}`)}?locale=${pick(["de-DE", "fr-FR", "ja-JP", "ar-SA"])}`);
  add("IP hosts", i => `http://${10 + i % 200}.${20 + i % 200}.${30 + i % 200}.${40 + i % 200}:${3000 + i}/${text(20)}?request=${i}`);
  add("matrix parameters", i => `https://${text(8).toLowerCase()}.systems/catalog;category=${text(7)};view=compact/item;id=${10000 + i}?language=en#details`);
  add("base64 values", i => `https://${text(8).toLowerCase()}.auth/callback?state=${text(48)}&code=${text(96)}&nonce=${text(32)}`);
  add("calendar URLs", i => `https://${text(7).toLowerCase()}.calendar/events/${2027 + i % 5}/${String(1 + i % 12).padStart(2, "0")}/${String(1 + i % 28).padStart(2, "0")}?start=${8 + i % 10}%3A00&end=${9 + i % 10}%3A30&tz=Europe%2FBerlin`);
  add("repository alternatives", i => `https://${pick(["gitlab.com", "bitbucket.org", "codeberg.org"] )}/${text(10)}/${text(12)}/${pick(["merge_requests", "commits", "src", "pipelines"])}/${text(16)}?ref=${text(12)}`);
  add("news articles", i => `https://${text(8).toLowerCase()}.news/${2028 + i % 3}/${String(1 + i % 12).padStart(2, "0")}/${String(1 + i % 28).padStart(2, "0")}/${Array.from({ length: 8 }, () => text(6).toLowerCase()).join("-")}?output=amp#comments`);
  add("moderate repetition", i => { const word = text(10).toLowerCase(); return `https://${text(8).toLowerCase()}.site/${word}/section/${word}/archive/${word}?primary=${word}&secondary=${word}-${i}`; });
  return rows;
}
