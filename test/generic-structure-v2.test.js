import test from "node:test";
import assert from "node:assert/strict";
import { compressDetailed, decompress } from "../src/codec.js";

const verifyCandidate = (url, option) => {
  const baseline = compressDetailed(url, { globalRawStream: true });
  const candidate = compressDetailed(url, { globalRawStream: true, [option]: true });
  assert.equal(candidate.plan.version, option === "queryOneBlock" ? 6 : 7);
  assert.equal(decompress(candidate.payload), new URL(url).href);
  assert.ok(candidate.payload.length <= baseline.payload.length, `${option} must retain the shorter complete representation`);
  return candidate;
};

test("retired generic hostname v2 option cannot be selected by the production encoder", () => {
  for (const url of ["https://unknown-label.photography/path", "https://alpha.beta.gamma.region.service.museum/path", "http://192.168.17.204:8080/path?x=1#fragment"]) {
    const baseline = compressDetailed(url, { globalRawStream: true });
    const retired = compressDetailed(url, { globalRawStream: true, genericHostnameV2: true });
    assert.equal(retired.payload, baseline.payload);
    assert.notEqual(retired.plan.selectedRepresentation, "genericHostnameV2");
  }
});

test("query-as-one-block preserves order, separators, duplicates, empty values, and escapes", () => {
  verifyCandidate("https://unknown.example/form?empty=&same=7&same=&flag&encoded=a%2Fb%20c&&last=#result", "queryOneBlock");
});

test("direct binary values preserve lowercase and uppercase hex exactly", () => {
  for (const value of ["deadbeef0123456789abcdef", "DEADBEEF0123456789ABCDEF"]) {
    const detail = verifyCandidate(`https://unknown.example/hash/${value}?copy=${value}`, "directBinaryValues");
    assert.ok((detail.plan.selectedFeatures.directBinaryValues || 0) > 0);
  }
});

test("direct binary values preserve Base64URL, UUIDs, numbers, and timestamps", () => {
  const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const url = `https://unknown.example/value/${base64}?uuid=550e8400-e29b-41d4-a716-446655440000&number=123456789012345&at=2026-09-19T12:34:56Z`;
  const detail = verifyCandidate(url, "directBinaryValues"); assert.ok((detail.plan.selectedFeatures.directBinaryValues || 0) > 0);
});

test("retired short URL v2 option cannot be selected by the production encoder", () => {
  for (const url of ["https://s.travel/J", "https://go.xyz/", "https://s.travel/J?q=1", "https://s.travel/J#part"]) {
    const baseline = compressDetailed(url, { globalRawStream: true });
    const retired = compressDetailed(url, { globalRawStream: true, shortUrlV2: true });
    assert.equal(retired.payload, baseline.payload);
    assert.notEqual(retired.plan.selectedRepresentation, "shortUrlV2");
  }
});
