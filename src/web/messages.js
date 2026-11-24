const messages = {
  byteCounter: "{used} / {limit} bytes",
  charsUnit: "{count} characters",
  savingsValue: "{count} characters ({percent}%)",
  noSavingsValue: "{count} more characters ({percent}%)",
  copySuccess: "Link copied.",
  copyFailure: "The link could not be copied automatically.",
  compressionSuccess: "URL compressed locally.",
  errorInvalidUrl: "Enter a complete, valid URL.",
  errorScheme: "Only HTTP and HTTPS URLs are accepted.",
  errorCredentials: "URLs containing a username or password are not accepted.",
  errorHamrUnsupported: "ha.mr cannot preserve this URL exactly. Select Automatic or URLForge.",
  errorInputLimit: "The URL exceeds the 8,192 UTF-8 byte limit.",
  errorPayloadLimit: "The result exceeds the codec's safe limits.",
  errorGeneric: "This URL could not be compressed safely.",
  qrTooLong: "The link was created, but QR code is unavailable above 2,000 characters.",
  qrFailure: "A reliable QR code could not be generated for this link.",
};

export function message(key, values = {}) {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    messages[key]
  );
}
