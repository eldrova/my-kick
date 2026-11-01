// Sidebar "Following" section, DOM side. The expanding itself is done in
// src/inject/following-expand.js; this only styles the result:
//  - expandFollowing: hide the Show More / Show Less bar.
//  - hideOfflineFollowing (only while expandFollowing is on): hide offline rows.
//    Offline rows have no category line and no green live dot.
(() => {
  if (window.top !== window) return;

  const SEL = {
    sidebar: "#sidebar-wrapper",
    row: 'a[data-testid^="sidebar-following-channel-"]',
  };
  const CLS = {
    hideButtons: "kt-following-no-more",
    hideOffline: "kt-following-hide-offline",
  };
  const OFFLINE_ATTR = "data-kt-offline";

  let expand = false;
  let hideOffline = false;
  let scheduled = null;

  const style = document.createElement("style");
  style.textContent = `
    html.${CLS.hideButtons} div:has(> button[data-testid="sidebar-show-more-following"]),
    html.${CLS.hideButtons} div:has(> button[data-testid="sidebar-show-less-following"]) {
      display: none !important;
    }
    html.${CLS.hideOffline} ${SEL.row}[${OFFLINE_ATTR}] {
      display: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const isOffline = (row) => {
    if (row.querySelector('[class*="voltGreen"]')) return false;
    // Live rows show "name + category"; offline rows only the name.
    const column = row.querySelector("span")?.parentElement;
    return !column || column.querySelectorAll(":scope > span").length < 2;
  };

  const update = () => {
    scheduled = null;
    const root = document.documentElement;
    root.classList.toggle(CLS.hideButtons, expand);
    root.classList.toggle(CLS.hideOffline, expand && hideOffline);
    for (const row of document.querySelectorAll(SEL.row)) {
      row.toggleAttribute(OFFLINE_ATTR, expand && isOffline(row));
    }
  };

  const schedule = () => {
    if (!scheduled) scheduled = setTimeout(update, 50);
  };

  // Watch only the sidebar (chat etc. mutate constantly). The sidebar can be
  // re-mounted, so re-check which node we're observing every couple of seconds.
  const observer = new MutationObserver(schedule);
  let observed = null;
  const attach = () => {
    const sidebar = document.querySelector(SEL.sidebar);
    if (sidebar && sidebar !== observed) {
      observer.disconnect();
      observer.observe(sidebar, { childList: true, subtree: true });
      observed = sidebar;
      schedule();
    }
  };
  setInterval(attach, 2000);
  document.addEventListener("DOMContentLoaded", attach);

  const applySettings = (s) => {
    expand = !!s.expandFollowing;
    hideOffline = !!s.hideOfflineFollowing;
    schedule();
  };

  ktGetSettings().then(applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) ktGetSettings().then(applySettings);
  });
})();
