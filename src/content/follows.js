// The logged-in user's full follow list, for other content scripts.
//
// GET /api/v2/channels/followed-page?cursor=N returns 20 channels per page
// (live first) with nextCursor until the end. Each channel has channel_slug,
// user_username, is_live, category_name, viewer_count, profile_picture, ...
// Kick authenticates it with the session_token cookie sent as a Bearer token;
// cookies alone get a 401.
//
// The last list is also kept in chrome.storage.local so it is available right
// at page load, before any card is rendered. It is refreshed in the background
// once older than MAX_AGE_MS.
//
//   await ktFollows.ready  -> the stored list (if any) has been read
//   ktFollows.peek()       -> current list or null, synchronously
//   ktFollows.get()        -> current list, fetching it first if there is none
//   ktFollows.onChange(fn) -> called with the new list after a refresh
const ktFollows = (() => {
  const API = "/api/v2/channels/followed-page";
  const STORAGE_KEY = "followsCache";
  const MAX_AGE_MS = 2 * 60 * 1000;
  const MAX_PAGES = 100;

  let channels = null;
  let loadedAt = 0;
  let inflight = null;
  const listeners = [];

  const token = () => {
    const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  };

  const ready = chrome.storage.local
    .get(STORAGE_KEY)
    .then(({ [STORAGE_KEY]: cache }) => {
      if (cache && Array.isArray(cache.channels) && token()) {
        channels = cache.channels;
        loadedAt = cache.at || 0;
      }
    })
    .catch(() => {});

  const fetchAll = async () => {
    const auth = token();
    if (!auth) return [];
    const headers = { Accept: "application/json", Authorization: `Bearer ${auth}` };
    const all = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = cursor == null ? API : `${API}?cursor=${encodeURIComponent(cursor)}`;
      const res = await fetch(url, { headers, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      all.push(...(data.channels || []));
      cursor = data.nextCursor;
      if (cursor == null || !data.channels?.length) break;
    }
    // Only what the block lists need; keeps the stored copy small.
    return all.map((c) => ({ channel_slug: c.channel_slug, user_username: c.user_username }));
  };

  const refresh = () => {
    inflight ||= fetchAll()
      .then((list) => {
        channels = list;
        loadedAt = Date.now();
        // Throws synchronously (not a rejected promise) once the extension
        // context is gone, so guard it separately from the fetch.
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: { at: loadedAt, channels: list } }).catch(() => {});
        } catch {}
        for (const fn of listeners) fn(list);
        return list;
      })
      .catch((e) => {
        // After the extension is reloaded or updated, scripts left running in
        // open tabs lose chrome.* access ("Extension context invalidated").
        // Nothing is wrong; the tab's next load runs the new copy.
        if (chrome.runtime?.id) console.warn("[My'Kick] could not load the follow list", e);
        // Keep what we had and wait MAX_AGE_MS before trying again.
        channels ||= [];
        loadedAt = Date.now();
        return channels;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    ready,
    peek: () => channels,
    get() {
      if (!channels) return refresh();
      if (Date.now() - loadedAt > MAX_AGE_MS) refresh();
      return Promise.resolve(channels);
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
})();
