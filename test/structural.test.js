import test from "node:test";
import assert from "node:assert/strict";
import { compress, decompress } from "../src/codec.js";

const verify = url => assert.equal(decompress(compress(url)), new URL(url).href);
const improves = (url, structural) => assert.ok(compress(url, { structural }).length < compress(url, { structural: false }).length);

test("structured common hostname improves without changing path", () => { const url = "https://docs.example.com/guide/reference"; verify(url); improves(url, { hostname: true, short: false, youtube: false, maps: false }); });
test("structured SLD and TLD labels preserve arbitrary DNS labels", () => { const url = "https://abcdefghijklmnop.github.dev/path"; verify(url); improves(url, { hostname: true, short: false, youtube: false, maps: false }); });
test("structured hostname preserves an explicit port", () => verify("http://api.example.com:8443/path?q=value"));
test("short URL format preserves root and trailing slash", () => { verify("https://example.com/"); improves("https://example.com/abc", { hostname: false, short: true, youtube: false, maps: false }); });
test("short URL falls back for unsupported path characters", () => verify("https://example.com/a.b/c?x=1#fragment"));
test("YouTube format preserves video and playlist IDs", () => { const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123456789abcdef"; verify(url); improves(url, { hostname: false, short: false, youtube: true, maps: false }); });
test("YouTube format falls back without changing parameter order", () => verify("https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&feature=share"));
test("Google Maps format preserves signed six-decimal coordinates", () => { const url = "https://maps.google.com/?q=-33.868820,151.209290&z=15"; verify(url); improves(url, { hostname: false, short: false, youtube: false, maps: true }); });
test("Google Maps format falls back when decimal spelling is not canonical", () => verify("https://maps.google.com/?q=51.50,-0.12&z=10#place"));
test("query order, duplicate names, empty values, and percent escapes stay exact", () => verify("https://example.com/search?b=2&a=1&a=&encoded=%2Fvalue%20here&b=3#done"));
