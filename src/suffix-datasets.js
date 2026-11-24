export function publicUrls(text) {
  const urls = new Map();
  for (const line of text.split(/\r?\n/)) {
    let url;
    try { url = new URL(line.trim()); } catch { continue; }
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) urls.set(url.href, url);
  }
  return [...urls.values()];
}

// Group subdomains together for the dataset split. This deliberately uses a coarse suffix key.
function domainGroup(url) {
  return url.hostname.split(".").slice(-2).join(".");
}

function domainBucket(domain) {
  let hash = 0;
  for (const char of domain) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % 8;
}

export function collectPublicUrls(adaText, holdoutText) {
  const holdout = publicUrls(holdoutText);
  const heldDomains = new Set(holdout.map(domainGroup));
  const training = [], adaHoldout = [], domainCounts = new Map();
  for (const url of publicUrls(adaText)) {
    const domain = domainGroup(url);
    if (heldDomains.has(domain) || url.href.length > 1400 || url.pathname === "/") continue;
    const count = domainCounts.get(domain) ?? 0;
    if (count >= 64) continue;
    domainCounts.set(domain, count + 1);
    if (domainBucket(domain) === 0) {
      if (adaHoldout.length < 400) adaHoldout.push(url);
    } else if (training.length < 20000) training.push(url);
  }
  return { training, adaHoldout, holdout };
}

export function collectQueryHoldout(adaText, { adaHoldout, holdout }) {
  const excluded = new Set([...adaHoldout, ...holdout].map(domainGroup));
  const counts = new Map(), sample = [];
  for (const url of publicUrls(adaText)) {
    const domain = domainGroup(url);
    if (!url.search || url.href.length > 1400 || domainBucket(domain) !== 0 || excluded.has(domain)) continue;
    const count = counts.get(domain) ?? 0;
    if (count >= 4) continue;
    counts.set(domain, count + 1);
    sample.push(url);
    if (sample.length === 500) break;
  }
  return sample;
}
