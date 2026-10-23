export const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

export function localize() {
  document.documentElement.lang = /^es(?:-|$)/i.test(chrome.i18n.getUILanguage()) ? "es" : "en";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ["title", "aria-label", "alt"]) {
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
