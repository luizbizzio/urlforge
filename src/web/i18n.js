import { translations } from "./translations.js";

export const SUPPORTED_LOCALES = Object.freeze(Object.keys(translations));
export const DEFAULT_LOCALE = "en";
export const LOCALE_STORAGE_KEY = "url-forge-locale";

export function normalizeLocale(value) {
  const locale = String(value || "").toLowerCase();
  return locale === "pt" || locale.startsWith("pt-") ? "pt-BR" : "en";
}

export function detectLocale({ storedLocale = null, browserLanguages = [] } = {}) {
  if (SUPPORTED_LOCALES.includes(storedLocale)) return storedLocale;
  return normalizeLocale(browserLanguages.find(Boolean));
}

export function translate(locale, key, values = {}) {
  const dictionary = translations[SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE];
  const template = dictionary[key] ?? translations[DEFAULT_LOCALE][key] ?? key;
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
}

export function applyTranslations(root, locale) {
  root.documentElement.lang = locale;
  for (const element of root.querySelectorAll("[data-i18n]")) element.textContent = translate(locale, element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-placeholder]")) element.setAttribute("placeholder", translate(locale, element.dataset.i18nPlaceholder));
  for (const element of root.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", translate(locale, element.dataset.i18nAriaLabel));
  for (const element of root.querySelectorAll("[data-i18n-alt]")) element.setAttribute("alt", translate(locale, element.dataset.i18nAlt));
  root.title = translate(locale, "pageTitle");
}
