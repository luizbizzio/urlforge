import assert from "node:assert/strict";
import test from "node:test";

import { INPUT_URL_MAX_BYTES, QR_MAX_LINK_CHARACTERS, resolvePublicConfig } from "../src/web/config.js";
import { createQrArtifacts, createQrModel, QrCodeError, renderQrPngBlob } from "../src/web/qr.js";
import { resolvePayloadFragment } from "../src/web/redirect.js";
import { createCompressionResult, UrlInputError, validateDestination } from "../src/web/url-service.js";

const localLocation = { origin: "http://localhost:5173", href: "http://localhost:5173/" };

test("web compression preserves HTTP, HTTPS, Unicode, duplicate query values, and fragments", () => {
  const config = resolvePublicConfig({}, localLocation);
  const inputs = [
    "http://example.com/path",
    "https://example.com/path",
    "https://例え.テスト/東京/🚀?q=ação",
    "https://example.com/path?dup=&dup=one&dup=two",
    "https://example.com/path?x=1#original%20fragment"
  ];
  for (const input of inputs) {
    const result = createCompressionResult(input, config.shortUrlBase);
    const resolved = resolvePayloadFragment(new URL(result.shortUrl).hash);
    assert.equal(resolved.ok, true, input);
    assert.equal(resolved.destination, new URL(input).href, input);
    assert.equal(result.shortUrl, `${config.shortUrlBase}${result.payload}`);
  }
});

test("codec modes preserve the complete URL and Automatic picks the smallest result", () => {
  const base = "https://uf.do/#";
  for (const destination of [
    "https://example.com/articles/how-we-built-a-language-model",
    "https://github.com/mikuta0407/win4wine"
  ]) {
    const forge = createCompressionResult(destination, base, "forge");
    const hamr = createCompressionResult(destination, base, "hamr");
    const auto = createCompressionResult(destination, base, "auto");
    assert.equal(forge.selectedFamily, "forge");
    assert.equal(hamr.selectedFamily, "hamr");
    assert.equal(auto.payloadCharacters, Math.min(forge.payloadCharacters, hamr.payloadCharacters));
    for (const result of [forge, hamr, auto]) {
      assert.equal(resolvePayloadFragment(new URL(result.shortUrl).hash).destination, destination);
    }
  }
  const signed = "https://example.com/a?x=%2f&x=&flag#";
  assert.throws(() => createCompressionResult(signed, base, "hamr"), { code: "HAMR_UNSUPPORTED" });
  for (const mode of ["forge", "auto"]) {
    const result = createCompressionResult(signed, base, mode);
    assert.equal(resolvePayloadFragment(new URL(result.shortUrl).hash).destination, signed);
  }
});

test("URL validation rejects invalid and non-HTTP(S) destinations", () => {
  assert.throws(() => validateDestination("not a URL"), error => error instanceof UrlInputError && error.code === "INVALID_URL");
  assert.throws(() => validateDestination("javascript:alert(1)"), error => error instanceof UrlInputError && error.code === "INVALID_SCHEME");
  assert.throws(() => validateDestination("https://user:secret@example.com/"), error => error instanceof UrlInputError && error.code === "CREDENTIALS");
  assert.equal(resolvePayloadFragment("#.").ok, false);
});

test("input validation accepts exactly 8192 UTF-8 bytes and rejects the next byte", () => {
  const prefix = "https://example.com/";
  const exact = `${prefix}${"a".repeat(INPUT_URL_MAX_BYTES - new TextEncoder().encode(prefix).length)}`;
  assert.equal(new TextEncoder().encode(exact).length, INPUT_URL_MAX_BYTES);
  assert.equal(validateDestination(exact).inputBytes, INPUT_URL_MAX_BYTES);
  assert.throws(() => validateDestination(`${exact}a`), error => error instanceof UrlInputError && error.code === "INPUT_LIMIT");
});

test("short-link base falls back locally and accepts an official configured HTTPS base", () => {
  assert.deepEqual(resolvePublicConfig({}, localLocation), { shortUrlBase: "http://localhost:5173/#", telemetryEndpoint: null, shortUrlBaseSource: "local" });
  assert.equal(resolvePublicConfig({ PUBLIC_SHORT_URL_BASE: "https://urlforge.pages.dev/#" }, localLocation).shortUrlBase, "https://urlforge.pages.dev/#");
  assert.throws(() => resolvePublicConfig({ PUBLIC_SHORT_URL_BASE: "http://public.example/#" }, localLocation), /SHORT_URL_BASE_REQUIRES_HTTPS/);
});

test("the four official hosts generate uf.do links and self-hosted instances keep their own host", () => {
  for (const host of ["uf.do", "www.uf.do", "urlforge.luizbizzio.com", "urlforge.pages.dev"]) {
    const location = new URL(`https://${host}/`);
    const { shortUrlBase } = resolvePublicConfig({}, location);
    const original = "https://example.com/articles/how-we-built-a-language-model";
    const { shortUrl } = createCompressionResult(original, shortUrlBase);
    assert.equal(new URL(shortUrl).origin, "https://uf.do");
    assert.equal(resolvePayloadFragment(new URL(shortUrl).hash).destination, original);
  }
  const location = new URL("https://urlforge.luizbizzio.com/");
  assert.equal(resolvePublicConfig({ PUBLIC_SHORT_URL_BASE: "https://custom.example/#" }, location).shortUrlBase, "https://custom.example/#");
  assert.equal(resolvePublicConfig({}, new URL("https://selfhost.example/")).shortUrlBase, "https://selfhost.example/#");
});

test("optional confirmation wraps each codec payload without changing the destination", () => {
  const base = "https://uf.do/#";
  const destination = "https://example.com/articles/how-we-built-a-language-model?x=1#original%20fragment";
  for (const mode of ["forge", "hamr", "auto"]) {
    const direct = createCompressionResult(destination, base, mode);
    const confirmed = createCompressionResult(destination, base, mode, { askBeforeOpening: true });
    assert.equal(direct.shortUrl, `${base}${direct.payload}`, mode);
    assert.equal(confirmed.shortUrl, `${base}:${direct.payload}`, mode);
    assert.equal(confirmed.payloadCharacters, direct.payloadCharacters);
    assert.equal(confirmed.finalShortUrlCharacters, direct.finalShortUrlCharacters + 1);
    for (const [result, askBeforeOpening] of [[direct, false], [confirmed, true]]) {
      const fragment = new URL(result.shortUrl).hash;
      assert.deepEqual(resolvePayloadFragment(fragment), { ok: true, destination, destinationScheme: "https", askBeforeOpening });
    }
  }
  assert.equal(resolvePayloadFragment("#:").ok, false);
  assert.equal(resolvePayloadFragment("#::").ok, false);
});

test("QR SVG and PNG are generated locally from the exact short URL", async () => {
  const shortUrl = "https://uf.example/#:.AbCd0123_-~";
  const artifacts = createQrArtifacts(shortUrl);
  assert.equal(artifacts.content, shortUrl);
  assert.equal(artifacts.model.content, shortUrl);
  assert.match(artifacts.svg, /^<svg/);
  assert.ok(artifacts.svg.includes(`data-url="${shortUrl}"`));
  assert.ok(artifacts.model.data.some(row => row.some(Boolean)));

  let canvas;
  const fakeDocument = { createElement(name) {
    assert.equal(name, "canvas");
    canvas = {
      width: 0, height: 0,
      getContext: () => ({ fillStyle: "", imageSmoothingEnabled: true, fillRect() {} }),
      toBlob: callback => callback(new Blob([shortUrl], { type: "image/png" }))
    };
    return canvas;
  } };
  const png = await renderQrPngBlob(artifacts.model, 512, fakeDocument);
  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 512);
  assert.equal(png.type, "image/png");
  assert.equal(await png.text(), shortUrl);
});

test("QR is blocked above the 2000-character product limit", () => {
  assert.equal(QR_MAX_LINK_CHARACTERS, 2000);
  assert.throws(() => createQrModel("x".repeat(QR_MAX_LINK_CHARACTERS + 1)), error => error instanceof QrCodeError && error.code === "QR_TOO_LONG");
});
