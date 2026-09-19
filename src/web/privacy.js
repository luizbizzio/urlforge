import { applyTranslations, detectLocale, LOCALE_STORAGE_KEY } from "./i18n.js";

const select = document.querySelector("#language");
let storedLocale = null;
try { storedLocale = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Storage is optional. */ }
let locale = detectLocale({ storedLocale, browserLanguages: navigator.languages || [navigator.language] });

function render() { applyTranslations(document, locale); select.value = locale; }
select.addEventListener("change", () => {
  locale = select.value;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Storage is optional. */ }
  render();
});
render();
