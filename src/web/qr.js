import { encode } from "uqr";
import { QR_MAX_LINK_CHARACTERS } from "./config.js";

export class QrCodeError extends Error {
  constructor(code) { super(code); this.name = "QrCodeError"; this.code = code; }
}

const xmlEscape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function createQrModel(shortUrl) {
  if (typeof shortUrl !== "string" || !shortUrl) throw new QrCodeError("INVALID_QR_CONTENT");
  if (shortUrl.length > QR_MAX_LINK_CHARACTERS) throw new QrCodeError("QR_TOO_LONG");
  try {
    const encoded = encode(shortUrl, { ecc: "M", boostEcc: true, border: 4 });
    return Object.freeze({ content: shortUrl, size: encoded.size, version: encoded.version, data: encoded.data });
  } catch { throw new QrCodeError("QR_ENCODING_FAILED"); }
}

export function renderQrSvg(model) {
  const commands = [];
  for (let y = 0; y < model.size; y++) for (let x = 0; x < model.size; x++) if (model.data[y][x]) commands.push(`M${x} ${y}h1v1H${x}z`);
  const content = xmlEscape(model.content);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${model.size} ${model.size}" shape-rendering="crispEdges" data-url="${content}"><metadata>${content}</metadata><rect width="100%" height="100%" fill="#ffffff"/><path d="${commands.join("")}" fill="#111827"/></svg>`;
}

export function createQrArtifacts(shortUrl) {
  const model = createQrModel(shortUrl);
  return { content: shortUrl, model, svg: renderQrSvg(model) };
}

export function renderQrPngBlob(model, pixelSize, documentLike = document) {
  if (![512, 1024].includes(pixelSize)) return Promise.reject(new QrCodeError("INVALID_PNG_SIZE"));
  const canvas = documentLike.createElement("canvas"), context = canvas.getContext("2d");
  if (!context) return Promise.reject(new QrCodeError("CANVAS_UNAVAILABLE"));
  canvas.width = canvas.height = pixelSize;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixelSize, pixelSize);
  context.fillStyle = "#111827";
  const moduleSize = Math.floor(pixelSize / model.size), offset = Math.floor((pixelSize - moduleSize * model.size) / 2);
  for (let y = 0; y < model.size; y++) {
    for (let x = 0; x < model.size; x++) if (model.data[y][x]) context.fillRect(offset + x * moduleSize, offset + y * moduleSize, moduleSize, moduleSize);
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new QrCodeError("PNG_ENCODING_FAILED")), "image/png"));
}
