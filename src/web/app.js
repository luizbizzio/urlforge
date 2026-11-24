import { isExactPayload, MetaCodecError, tryDecompress as tryLegacy } from "../meta-codec.js";
import { isCompactFragment } from "../output-encoding.js";
import { INPUT_URL_MAX_BYTES, QR_MAX_LINK_CHARACTERS, resolvePublicConfig } from "./config.js";
import { readLinkFragment } from "./link-fragment.js";
import { message } from "./messages.js";
import { createQrArtifacts, QrCodeError, renderQrPngBlob } from "./qr.js";
import { readShortcutDestination } from "./shortcut.js";
import { createTelemetryEvent, sendTelemetry } from "./telemetry.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
const encoder = new TextEncoder();
const config = resolvePublicConfig(import.meta.env, window.location);
const root = document.documentElement;
const basePath = import.meta.env.BASE_URL;
const shortcutPath = `${basePath}compress`;
const incomingDestination = readShortcutDestination(window.location, basePath);
const isShortcutPage = incomingDestination !== null || window.location.pathname.replace(/\/$/, "").toLowerCase() === shortcutPath.toLowerCase();
let currentResult = null, currentQr = null, qrPreviewUrl = null;
let compressionRequest = 0;
let hasSubmitted = false;
let isCompressing = false;

const errorMessageKey = error => {
  const code = error?.code;
  if (code === "INVALID_URL") return "errorInvalidUrl";
  if (code === "INVALID_SCHEME") return "errorScheme";
  if (code === "CREDENTIALS" || code === "UNSUPPORTED_URL") return "errorCredentials";
  if (code === "HAMR_UNSUPPORTED") return "errorHamrUnsupported";
  if (code === "INPUT_LIMIT" || code === "INPUT_URL_TOO_LARGE") return "errorInputLimit";
  if (["PAYLOAD_TOO_LARGE", "ENCODED_PAYLOAD_TOO_LARGE", "URL_TOO_LARGE", "DECODE_BUDGET_EXCEEDED"].includes(code)) return "errorPayloadLimit";
  return "errorGeneric";
};

function setStatus(key, type = "success") {
  const text = message(key);
  const className = `status ${type}`;
  if (elements.status.textContent !== text) elements.status.textContent = text;
  if (elements.status.className !== className) elements.status.className = className;
  if (elements.status.hidden) elements.status.hidden = false;
}

function clearStatus() { elements.status.hidden = true; elements.status.textContent = ""; }

function renderCounter() {
  const used = encoder.encode(elements["url-input"].value).length;
  elements["byte-counter"].textContent = message("byteCounter", { used, limit: INPUT_URL_MAX_BYTES });
  elements["byte-counter"].classList.toggle("over-limit", used > INPUT_URL_MAX_BYTES);
  return used;
}

function renderResult() {
  if (!currentResult) return;
  elements["short-url"].value = currentResult.shortUrl;
  elements["final-chars"].textContent = message("charsUnit", { count: currentResult.finalShortUrlCharacters });
  const savingKey = currentResult.savedCharacters >= 0 ? "savingsValue" : "noSavingsValue";
  elements["saved-chars"].textContent = message(savingKey, { count: Math.abs(currentResult.savedCharacters), percent: Math.abs(currentResult.savingsPercent).toFixed(1) });
  const qrTooLong = currentResult.finalShortUrlCharacters > QR_MAX_LINK_CHARACTERS;
  elements["qr-button"].disabled = qrTooLong;
  elements["qr-limit-message"].hidden = !qrTooLong;
  elements["qr-limit-message"].textContent = qrTooLong ? message("qrTooLong") : "";
  elements.result.hidden = false;
}

function resetResult() {
  currentResult = null;
  elements.result.hidden = true;
}

function emit(eventType, fields) {
  sendTelemetry(createTelemetryEvent(eventType, { ...fields, locale: "en" }), { endpoint: config.telemetryEndpoint });
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
  const hasPayload = Boolean(hash);
  elements["app-view"].hidden = hasPayload;
  elements["redirect-view"].hidden = true;
  elements["redirect-confirmation"].hidden = true;
  elements["redirect-continue"].removeAttribute("href");
  delete root.dataset.entryReady;
  if (!hasPayload) {
    delete root.dataset.entry;
    return;
  }
  root.dataset.entry = "redirect";
  elements["redirect-back"].hidden = true;
  const started = performance.now();
  const { payload, askBeforeOpening } = readLinkFragment(hash);
  let result;
  try {
    const decode = isExactPayload(payload) || isCompactFragment(payload) ? (await import("../url-codec.js")).tryDecompress : tryLegacy;
    result = decode(payload);
  } catch { result = { ok: false, error: { code: "INVALID_FORGE_PAYLOAD" } }; }
  if (window.location.hash !== hash) return;
  let destinationScheme;
  let errorCode = result.error?.code;
  if (result.ok) {
    const destination = new URL(result.value);
    destinationScheme = destination.protocol.slice(0, -1);
    try {
      if (askBeforeOpening) {
        elements["redirect-title"].textContent = "Continue to this site?";
        elements["redirect-description"].textContent = "Check the destination before opening this link.";
        elements["redirect-host"].textContent = destination.host;
        elements["redirect-url"].textContent = result.value;
        elements["redirect-continue"].href = result.value;
        elements["redirect-confirmation"].hidden = false;
        showRedirectCard();
        elements["redirect-title"].focus({ preventScroll: true });
      } else {
        window.location.replace(result.value);
      }
      emit("resolve_success", { destinationScheme, durationMs: performance.now() - started });
      return;
    } catch {
      errorCode = "REDIRECT_ATTEMPT_FAILED";
    }
  }
  emit("resolve_failure", { destinationScheme, durationMs: performance.now() - started, errorCode });
  elements["redirect-title"].textContent = "This link could not be opened";
  elements["redirect-description"].textContent = "The payload is invalid, corrupted, or exceeds the safe limits.";
  elements["redirect-back"].hidden = false;
  showRedirectCard();
}

function showRedirectCard() {
  elements["redirect-view"].hidden = false;
  root.dataset.entryReady = "";
}

elements["example-button"].addEventListener("click", () => {
  elements["url-input"].value = "https://en.wikipedia.org/wiki/List_of_Internet_top-level_domains";
  renderCounter();
  elements["compress-form"].requestSubmit();
});
function recompressWithOptions() {
  if (hasSubmitted && elements["url-input"].value.trim()) elements["compress-form"].requestSubmit();
}

elements.codec.addEventListener("change", recompressWithOptions);
elements["ask-before-opening"].addEventListener("change", recompressWithOptions);
elements["url-input"].addEventListener("input", () => {
  hasSubmitted = false;
  isCompressing = false;
  compressionRequest++;
  resetResult();
  clearStatus();
  releaseQr();
  renderCounter();
});
elements["compress-form"].addEventListener("submit", async event => {
  event.preventDefault();
  hasSubmitted = true;
  isCompressing = true;
  const request = ++compressionRequest;
  const input = elements["url-input"].value;
  const mode = elements.codec.value;
  const askBeforeOpening = elements["ask-before-opening"].checked;
  const started = performance.now();
  try {
    const { createCompressionResult } = await import("./url-service.js");
    if (request !== compressionRequest || input !== elements["url-input"].value) return;
    const result = createCompressionResult(input, config.shortUrlBase, mode, { askBeforeOpening });
    const linkChanged = currentResult?.shortUrl !== result.shortUrl;
    currentResult = result;
    if (linkChanged) {
      releaseQr();
      renderResult();
    }
    if (isShortcutPage && elements["compress-form"].hidden) elements["edit-shortcut-button"].hidden = false;
    setStatus("compressionSuccess");
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
    releaseQr();
    elements["compress-form"].hidden = false;
    const normalizedError = error?.name === "UrlInputError" || error instanceof MetaCodecError ? error : { code: "COMPRESSION_FAILED" };
    setStatus(errorMessageKey(normalizedError), "error");
    emit("compress_failure", { originalUrlBytes: renderCounter(), durationMs: performance.now() - started, errorCode: normalizedError.code });
  } finally {
    if (request === compressionRequest) {
      isCompressing = false;
      if (isShortcutPage) root.dataset.entryReady = "";
    }
  }
});

elements["edit-shortcut-button"].addEventListener("click", () => {
  elements["edit-shortcut-button"].hidden = true;
  elements["compress-form"].hidden = false;
  elements["url-input"].focus();
});

elements["clear-button"].addEventListener("click", () => {
  hasSubmitted = false;
  isCompressing = false;
  compressionRequest++;
  if (isShortcutPage) window.history.replaceState(null, "", shortcutPath);
  elements["url-input"].value = "";
  resetResult();
  clearStatus();
  releaseQr();
  renderCounter();
  elements["url-input"].focus();
});

elements["copy-button"].addEventListener("click", async () => {
  if (isCompressing || !currentResult) return;
  const result = currentResult;
  try {
    await navigator.clipboard.writeText(result.shortUrl);
    if (currentResult === result && !isCompressing) setStatus("copySuccess");
  } catch {
    if (currentResult !== result || isCompressing) return;
    elements["short-url"].select();
    setStatus("copyFailure", "error");
  }
});
elements["open-button"].addEventListener("click", () => {
  if (!isCompressing && currentResult) window.open(currentResult.shortUrl, "_blank", "noopener,noreferrer");
});

elements["qr-button"].addEventListener("click", () => {
  if (isCompressing || !currentResult) return;
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

if (isShortcutPage) {
  root.dataset.entry = "shortcut";
  document.title = "Compress a link · URLForge";
  if (incomingDestination !== null) window.history.replaceState({ urlForgeShortcut: incomingDestination }, "", shortcutPath);
  const destination = window.history.state?.urlForgeShortcut;
  if (typeof destination === "string") {
    elements["url-input"].value = destination;
    elements["compress-form"].hidden = true;
    elements["compress-form"].requestSubmit();
  } else {
    root.dataset.entryReady = "";
  }
} else {
  handleRedirect();
  window.addEventListener("hashchange", handleRedirect);
}
renderCounter();
