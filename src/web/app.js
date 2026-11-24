import { isExactPayload, MetaCodecError, tryDecompress as tryLegacy } from "../meta-codec.js";
import { isCompactFragment } from "../output-encoding.js";
import { INPUT_URL_MAX_BYTES, QR_MAX_LINK_CHARACTERS, resolvePublicConfig } from "./config.js";
import { applyTranslations, detectLocale, LOCALE_STORAGE_KEY, translate } from "./i18n.js";
import { createQrArtifacts, QrCodeError, renderQrPngBlob } from "./qr.js";
import { createTelemetryEvent, sendTelemetry } from "./telemetry.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
const encoder = new TextEncoder();
const config = resolvePublicConfig(import.meta.env, window.location);
let storedLocale = null;
try { storedLocale = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Language storage is optional. */ }
let locale = detectLocale({ storedLocale });
let currentResult = null, currentQr = null, qrPreviewUrl = null, statusState = null;
let compressionRequest = 0;

const errorTranslation = error => {
  const code = error?.code;
  if (code === "INVALID_URL") return "errorInvalidUrl";
  if (code === "INVALID_SCHEME") return "errorScheme";
  if (code === "CREDENTIALS" || code === "UNSUPPORTED_URL") return "errorCredentials";
  if (code === "HAMR_UNSUPPORTED") return "errorHamrUnsupported";
  if (code === "INPUT_LIMIT" || code === "INPUT_URL_TOO_LARGE") return "errorInputLimit";
  if (["PAYLOAD_TOO_LARGE", "ENCODED_PAYLOAD_TOO_LARGE", "URL_TOO_LARGE", "DECODE_BUDGET_EXCEEDED"].includes(code)) return "errorPayloadLimit";
  return "errorGeneric";
};

function setStatus(key, type = "success", values = {}) {
  statusState = { key, type, values };
  elements.status.textContent = translate(locale, key, values);
  elements.status.className = `status ${type}`;
  elements.status.hidden = false;
}

function clearStatus() { statusState = null; elements.status.hidden = true; elements.status.textContent = ""; }

function renderCounter() {
  const used = encoder.encode(elements["url-input"].value).length;
  elements["byte-counter"].textContent = translate(locale, "byteCounter", { used, limit: INPUT_URL_MAX_BYTES });
  elements["byte-counter"].classList.toggle("over-limit", used > INPUT_URL_MAX_BYTES);
  return used;
}

function renderResult() {
  if (!currentResult) return;
  elements["short-url"].value = currentResult.shortUrl;
  elements["final-chars"].textContent = translate(locale, "charsUnit", { count: currentResult.finalShortUrlCharacters });
  const savingKey = currentResult.savedCharacters >= 0 ? "savingsValue" : "noSavingsValue";
  elements["saved-chars"].textContent = translate(locale, savingKey, { count: Math.abs(currentResult.savedCharacters), percent: Math.abs(currentResult.savingsPercent).toFixed(1) });
  const qrTooLong = currentResult.finalShortUrlCharacters > QR_MAX_LINK_CHARACTERS;
  elements["qr-button"].disabled = qrTooLong;
  elements["qr-limit-message"].hidden = !qrTooLong;
  elements["qr-limit-message"].textContent = qrTooLong ? translate(locale, "qrTooLong") : "";
  elements.result.hidden = false;
}

function resetResult() {
  currentResult = null;
  elements.result.hidden = true;
}

function renderLanguage() {
  applyTranslations(document, locale);
  elements.language.value = locale;
  renderCounter();
  renderResult();
  if (statusState) setStatus(statusState.key, statusState.type, statusState.values);
}

function emit(eventType, fields) {
  sendTelemetry(createTelemetryEvent(eventType, { ...fields, locale }), { endpoint: config.telemetryEndpoint });
}

function releaseQr() {
  if (qrPreviewUrl) URL.revokeObjectURL(qrPreviewUrl);
  qrPreviewUrl = null; currentQr = null; elements["qr-panel"].hidden = true; elements["qr-preview"].removeAttribute("src");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.hidden = true;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function handleRedirect() {
  const hash = window.location.hash;
  const hasPayload = Boolean(hash && hash !== "#");
  elements["app-view"].hidden = hasPayload;
  elements["redirect-view"].hidden = !hasPayload;
  if (!hasPayload) return;
  elements["redirect-title"].textContent = translate(locale, "resolvingTitle");
  elements["redirect-description"].textContent = translate(locale, "resolvingDescription");
  elements["redirect-back"].hidden = true;
  const spinner = document.querySelector(".spinner");
  spinner.hidden = false;
  const started = performance.now();
  const payload = hash.slice(1);
  let result;
  try {
    const decode = isExactPayload(payload) || isCompactFragment(payload) ? (await import("../url-codec.js")).tryDecompress : tryLegacy;
    result = decode(payload);
  } catch { result = { ok: false, error: { code: "INVALID_FORGE_PAYLOAD" } }; }
  if (window.location.hash !== hash) return;
  if (result.ok) {
    const destinationScheme = new URL(result.value).protocol.slice(0, -1);
    try {
      window.location.replace(result.value);
      emit("resolve_success", { destinationScheme, durationMs: performance.now() - started });
    } catch {
      emit("resolve_failure", { destinationScheme, durationMs: performance.now() - started, errorCode: "REDIRECT_ATTEMPT_FAILED" });
      elements["redirect-title"].textContent = translate(locale, "redirectErrorTitle");
      elements["redirect-description"].textContent = translate(locale, "redirectErrorDescription");
      elements["redirect-back"].hidden = false;
      spinner.hidden = true;
    }
  } else {
    emit("resolve_failure", { durationMs: performance.now() - started, errorCode: result.error.code });
    elements["redirect-title"].textContent = translate(locale, "redirectErrorTitle");
    elements["redirect-description"].textContent = translate(locale, "redirectErrorDescription");
    elements["redirect-back"].hidden = false;
    spinner.hidden = true;
  }
}

elements.language.addEventListener("change", () => {
  locale = elements.language.value;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Language storage is optional. */ }
  renderLanguage();
});

elements["example-button"].addEventListener("click", () => {
  elements["url-input"].value = "https://en.wikipedia.org/wiki/List_of_Internet_top-level_domains";
  renderCounter();
  elements["compress-form"].requestSubmit();
});
elements.codec.addEventListener("change", () => {
  const hadAttempt = currentResult !== null || statusState !== null;
  compressionRequest++;
  resetResult();
  clearStatus();
  releaseQr();
  if (hadAttempt && elements["url-input"].value.trim()) elements["compress-form"].requestSubmit();
});
elements["url-input"].addEventListener("input", () => {
  compressionRequest++;
  resetResult();
  clearStatus();
  releaseQr();
  renderCounter();
});
elements["compress-form"].addEventListener("submit", async event => {
  event.preventDefault(); clearStatus(); releaseQr();
  const request = ++compressionRequest;
  const input = elements["url-input"].value;
  const mode = elements.codec.value;
  const started = performance.now();
  try {
    const { createCompressionResult } = await import("./url-service.js");
    if (request !== compressionRequest || input !== elements["url-input"].value) return;
    currentResult = createCompressionResult(input, config.shortUrlBase, mode);
    renderResult(); setStatus("compressionSuccess");
    emit("compress_success", {
      originalUrlBytes: currentResult.inputBytes,
      compressedPayloadChars: currentResult.payloadCharacters,
      finalShortUrlChars: currentResult.finalShortUrlCharacters,
      savedChars: currentResult.savedCharacters,
      selectedFamily: currentResult.selectedFamily,
      selectedRepresentation: currentResult.selectedRepresentation,
      destinationScheme: currentResult.destinationScheme,
      durationMs: performance.now() - started
    });
  } catch (error) {
    if (request !== compressionRequest || input !== elements["url-input"].value) return;
    resetResult();
    const normalizedError = error?.name === "UrlInputError" || error instanceof MetaCodecError ? error : { code: "COMPRESSION_FAILED" };
    setStatus(errorTranslation(normalizedError), "error");
    emit("compress_failure", { originalUrlBytes: renderCounter(), durationMs: performance.now() - started, errorCode: normalizedError.code });
  }
});

elements["clear-button"].addEventListener("click", () => {
  compressionRequest++;
  elements["url-input"].value = "";
  resetResult();
  clearStatus();
  releaseQr();
  renderCounter();
  elements["url-input"].focus();
});

elements["copy-button"].addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentResult.shortUrl); setStatus("copySuccess"); }
  catch { elements["short-url"].select(); setStatus("copyFailure", "error"); }
});
elements["open-button"].addEventListener("click", () => window.open(currentResult.shortUrl, "_blank", "noopener,noreferrer"));

elements["qr-button"].addEventListener("click", () => {
  try {
    currentQr = createQrArtifacts(currentResult.shortUrl);
    if (qrPreviewUrl) URL.revokeObjectURL(qrPreviewUrl);
    qrPreviewUrl = URL.createObjectURL(new Blob([currentQr.svg], { type: "image/svg+xml" }));
    elements["qr-preview"].src = qrPreviewUrl;
    elements["qr-panel"].hidden = false;
    elements["qr-panel"].scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) { setStatus(error instanceof QrCodeError && error.code === "QR_TOO_LONG" ? "qrTooLong" : "qrFailure", "error"); }
});

elements["download-svg"].addEventListener("click", () => downloadBlob(new Blob([currentQr.svg], { type: "image/svg+xml" }), "url-forge-qr.svg"));
elements["download-png"].addEventListener("click", async () => {
  try { downloadBlob(await renderQrPngBlob(currentQr.model, Number(elements["qr-size"].value)), "url-forge-qr.png"); }
  catch { setStatus("qrFailure", "error"); }
});

renderLanguage();
handleRedirect();
window.addEventListener("hashchange", handleRedirect);
