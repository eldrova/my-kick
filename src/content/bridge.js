// Isolated-world content script: relays settings from chrome.storage to the
// MAIN-world scripts (which can't use chrome.* APIs) and keeps the latest
// player status so the popup can show it.
(() => {
  const MSG_SOURCE = "kick-tools";
  let lastStatus = null;

  const toPage = (type, payload = {}) =>
    window.postMessage({ source: MSG_SOURCE, dir: "to-page", type, ...payload }, "*");

  const pushSettings = async () => toPage("settings", { settings: await ktGetSettings() });

  pushSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) pushSettings();
  });

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-bridge") return;
    if (d.type === "status") lastStatus = d.status;
  });

  // Only the top frame answers the popup, otherwise every iframe would reply.
  if (window.top !== window) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "get-status") return;
    toPage("get-status");
    // Give the page a moment to post a fresh status back.
    setTimeout(() => sendResponse({ status: lastStatus }), 150);
    return true;
  });
})();
