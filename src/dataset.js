function mulberry32(seed) {
  return () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const random = mulberry32(0x55524c46);
const pick = values => values[Math.floor(random() * values.length)];
const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const randomText = length => Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join("");
const hex = length => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick("89ab")}${hex(3)}-${hex(12)}`;

export function buildDataset(perCategory = 100) {
  const rows = [];
  const add = (category, factory) => { for (let i = 0; i < perCategory; i++) rows.push({ category, url: factory(i) }); };
  add("short URLs", i => `https://${pick(["example.com", "x.com", "github.com", "google.com"])}/${randomText(2 + i % 6)}`);
  add("long paths", i => `https://example.com/${Array.from({ length: 8 + i % 12 }, (_, j) => `section-${j}-${randomText(8)}`).join("/")}`);
  add("GitHub", i => `https://github.com/${randomText(8)}/${randomText(10)}/${pick(["issues", "pull", "commit", "blob/main/src"])}/${i + 1}${i % 3 ? "" : `?utm_source=github&utm_medium=web`}`);
  add("YouTube", i => `https://www.youtube.com/watch?v=${randomText(11)}${i % 2 ? `&list=PL${randomText(16)}` : ""}`);
  add("Google", i => `https://www.google.com/search?q=${encodeURIComponent(`url compression example ${i}`)}&source=${pick(["web", "mobile", "desktop"])}`);
  add("Google Maps", i => `https://maps.google.com/?q=${(40 + random() * 20).toFixed(6)},${(-10 + random() * 30).toFixed(6)}&z=${10 + i % 9}`);
  add("tracking parameters", i => `https://shop.example.com/products/${100000 + i}?utm_source=${pick(["google", "newsletter", "social"])}&utm_medium=${pick(["cpc", "email", "organic"])}&utm_campaign=campaign_${i}&gclid=${randomText(24)}`);
  add("UUIDs", i => `https://api.example.com/users/${uuid()}/events/${uuid()}?page=${i + 1}`);
  add("numeric IDs", i => `https://example.com/users/${1000000000 + i}/orders/${900000000000 + i}?page=${i + 1}&limit=50`);
  add("timestamps", i => `https://api.example.com/events?created=2026-09-${String(1 + i % 28).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z&limit=50`);
  add("hexadecimal hashes", i => `https://github.com/example/project/commit/${hex(40)}?ref=${hex(16)}`);
  add("random URLs", i => `https://${randomText(10).toLowerCase()}.${pick(["com", "org", "io", "dev"])}/${randomText(12)}/${randomText(20)}?${randomText(7)}=${randomText(18)}&${randomText(5)}=${randomText(10)}`);
  add("Unicode", i => `https://例え.テスト/${pick(["東京", "münchen", "café", "ação", "🚀"])}/${i}?q=${encodeURIComponent(pick(["olá mundo", "日本語", "straße", "mañana"]))}`);
  add("fragments", i => `https://docs.example.com/guide/${randomText(12)}#${pick(["installation", "usage", "examples", "api-reference"])}-${i}`);
  return rows;
}
