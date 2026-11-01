// Runs in the page's MAIN world at document_start. Auto-accepts chat rules.
//
// Accepting chat rules on Kick is purely client-side, no API call:
//  - Rules text: GET web.kick.com/api/v1/channels/{id}/chat/settings -> data.rules
//  - "I agree" stores { chatroomId: id, hash: hash(rules) } in
//    localStorage "accepted_chat_rules" (Mantine useLocalStorage).
//  - The panel is skipped when an entry for the channel has a matching hash, so
//    changed rules show up again.
// We store that entry ourselves when the settings response comes in, before
// Kick sees it. Mantine's hook also listens for the "mantine-local-storage"
// event, which lets us close a panel that is already open.
(() => {
  if (window.__kickToolsChatRules) return;
  window.__kickToolsChatRules = true;

  const MSG_SOURCE = "kick-tools";
  const STORAGE_KEY = "accepted_chat_rules";
  const SETTINGS_PATH = /^\/api\/v1\/channels\/(\d+)\/chat\/settings$/;

  let settings = null;
  const waiters = new Set();
  const settingsReady = () =>
    settings
      ? Promise.resolve(settings)
      : new Promise((resolve) => {
          waiters.add(resolve);
          setTimeout(() => {
            waiters.delete(resolve);
            resolve(settings || {});
          }, 1000);
        });
  const enabled = () => !!settings?.autoAcceptChatRules;

  // Same hash Kick uses (Java-style String.hashCode).
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  };

  // Rules of the last few chats opened, to accept them if the setting is turned
  // on while a rules panel is already showing. Capped so it doesn't grow over a
  // long session of channel hopping.
  const rulesByChannel = new Map();
  const MAX_REMEMBERED = 5;
  const remember = (channelId, rules) => {
    rulesByChannel.delete(channelId);
    rulesByChannel.set(channelId, rules);
    while (rulesByChannel.size > MAX_REMEMBERED) rulesByChannel.delete(rulesByChannel.keys().next().value);
  };

  const accept = (channelId, rules) => {
    if (!rules) return;
    const h = hash(rules);
    let list;
    try {
      list = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(list)) list = [];
    } catch {
      list = [];
    }
    if (list.some((e) => e.chatroomId === channelId && e.hash === h)) return;
    list = [...list.filter((e) => e.chatroomId !== channelId), { chatroomId: channelId, hash: h }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("mantine-local-storage", { detail: { key: STORAGE_KEY, value: list } }));
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    let match = null;
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      const url = new URL(raw, location.href);
      if (/(^|\.)kick\.com$/.test(url.hostname)) match = url.pathname.match(SETTINGS_PATH);
    } catch {}
    if (!match || (init?.method && init.method.toUpperCase() !== "GET")) return origFetch.apply(this, arguments);

    const response = await origFetch.apply(this, arguments);
    if (!response.ok) return response;
    try {
      const body = await response.clone().json();
      const channelId = Number(body?.data?.channel_id ?? match[1]);
      const rules = body?.data?.rules ?? "";
      remember(channelId, rules);
      await settingsReady();
      if (enabled()) accept(channelId, rules);
    } catch (e) {
      console.warn("[My'Kick] could not auto-accept chat rules", e);
    }
    return response;
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-page" || d.type !== "settings") return;
    settings = d.settings || {};
    for (const resolve of waiters) resolve(settings);
    waiters.clear();
    // Turned on while a rules panel is open: accept what we've already seen.
    if (enabled()) for (const [id, rules] of rulesByChannel) accept(id, rules);
  });
})();
