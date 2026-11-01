// Runs in the page's MAIN world at document_start. Expands the sidebar
// "Following" list without clicking "Show More".
//
// Kick's list (component with a react-query infinite query):
//  - GET /api/v2/channels/followed?cursor=N returns 5 channels per page. The
//    cursor is a plain offset (0, 5, 10, ...), live channels come first.
//  - A local useState counter (starts at 5) decides how many rows render;
//    "Show More" adds 5 and calls fetchNextPage() when needed.
//
// While "Expand Following" is on:
//  1. The first-page request is answered with every page merged into one
//     (fetched in parallel) and nextCursor: null, so there is nothing left to
//     load. Kick's own 5-minute refetch goes through here too and stays merged.
//     With "Hide offline channels" on we stop at the first page with an
//     offline channel: live ones come first, so all of them are loaded by then.
//  2. The row counter is set straight to a large number through React's fiber.
(() => {
  if (window.__kickToolsFollowingExpand) return;
  window.__kickToolsFollowingExpand = true;

  const MSG_SOURCE = "kick-tools";
  const API_PATH = "/api/v2/channels/followed";
  const PARALLEL = 8;
  const MAX_PAGES = 200;
  const ROW_SEL = 'a[data-testid^="sidebar-following-channel-"]';
  const MORE_SEL = 'button[data-testid="sidebar-show-more-following"]';
  const SHOW_ALL = 100000;

  let settings = null;
  const waiters = new Set();
  const settingsReady = () =>
    settings
      ? Promise.resolve(settings)
      : new Promise((resolve) => {
          waiters.add(resolve);
          // Don't hold Kick's request forever if the bridge never answers.
          setTimeout(() => {
            waiters.delete(resolve);
            resolve(settings || {});
          }, 1000);
        });

  const expandOn = () => !!settings?.expandFollowing;
  const hideOfflineOn = () => expandOn() && !!settings?.hideOfflineFollowing;

  // --- 1. Merge all pages into the first response -------------------------

  const origFetch = window.fetch;

  const requestUrl = (input) => {
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      return new URL(raw, location.href);
    } catch {
      return null;
    }
  };

  const fetchPage = async (url, cursor, init) => {
    const u = new URL(url);
    u.searchParams.set("cursor", cursor);
    const res = await origFetch(u.href, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const loadAll = async (url, init, first) => {
    const channels = [...(first.channels || [])];
    const step = first.channels?.length || 5;
    const stopAtOffline = hideOfflineOn();
    let next = first.nextCursor;
    let pages = 1;

    while (next != null && pages < MAX_PAGES) {
      if (stopAtOffline && channels.some((c) => !c.is_live)) break;
      const cursors = Array.from({ length: PARALLEL }, (_, i) => next + i * step);
      const batch = await Promise.all(cursors.map((c) => fetchPage(url, c, init)));
      pages += batch.length;
      next = null;
      for (const page of batch) {
        channels.push(...(page.channels || []));
        if (page.nextCursor == null || !page.channels?.length) {
          next = null;
          break;
        }
        next = page.nextCursor;
      }
    }
    return channels;
  };

  window.fetch = async function (input, init) {
    const url = requestUrl(input);
    const isFirstPage =
      url && url.origin === location.origin && url.pathname === API_PATH && !url.searchParams.has("cursor");
    if (!isFirstPage || (init?.method && init.method !== "GET")) return origFetch.apply(this, arguments);

    await settingsReady();
    const response = await origFetch.apply(this, arguments);
    if (!expandOn() || !response.ok) return response;

    try {
      const first = await response.clone().json();
      const channels = await loadAll(url, init, first);
      const seen = new Set();
      const unique = channels.filter((c) => !seen.has(c.channel_slug) && seen.add(c.channel_slug));
      return new Response(JSON.stringify({ ...first, channels: unique, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      console.warn("[My'Kick] could not load the full Following list", e);
      return response;
    }
  };

  // --- 2. Show every loaded row --------------------------------------------

  const findList = () => {
    const anchor = document.querySelector(ROW_SEL) || document.querySelector(MORE_SEL);
    if (!anchor) return null;
    const key = Object.keys(anchor).find((k) => k.startsWith("__reactFiber"));
    for (let f = key && anchor[key]; f; f = f.return) {
      if (typeof f.type !== "function") continue;
      let observer = null;
      const counters = [];
      for (let h = f.memoizedState; h; h = h.next) {
        const s = h.memoizedState;
        if (s && typeof s === "object" && typeof s.fetchNextPage === "function" && typeof s.refetch === "function") {
          observer = s;
        } else if (typeof s === "number" && h.queue?.dispatch) {
          counters.push(h);
        }
      }
      if (observer) {
        // The row counter is the useState(5) that only moves in steps of 5.
        const counter = counters.find((c) => c.memoizedState >= 5 && c.memoizedState % 5 === 0);
        return { observer, counter };
      }
    }
    return null;
  };

  let refetchedFor = null;

  const expandList = () => {
    if (!expandOn()) return;
    const list = findList();
    if (!list) return;
    if (list.counter && list.counter.memoizedState < SHOW_ALL) list.counter.queue.dispatch(SHOW_ALL);
    // More pages to load means the data was fetched before the merge applied
    // (e.g. the setting was just turned on): refetch once so it goes through it.
    const hasNextPage = list.observer.getCurrentResult?.().hasNextPage;
    if (hasNextPage && refetchedFor !== list.observer) {
      refetchedFor = list.observer;
      list.observer.refetch();
    }
  };

  let scheduled = null;
  const schedule = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      try {
        expandList();
      } catch (e) {
        console.warn("[My'Kick] could not expand Following", e);
      }
    }, 100);
  };

  const observer = new MutationObserver(schedule);
  let observed = null;
  setInterval(() => {
    const sidebar = document.getElementById("sidebar-wrapper");
    if (sidebar && sidebar !== observed) {
      observer.disconnect();
      observer.observe(sidebar, { childList: true, subtree: true });
      observed = sidebar;
      schedule();
    }
  }, 1000);

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-page" || d.type !== "settings") return;
    const prev = settings;
    settings = d.settings || {};
    for (const resolve of waiters) resolve(settings);
    waiters.clear();
    const changed =
      prev &&
      (!!prev.expandFollowing !== !!settings.expandFollowing ||
        !!prev.hideOfflineFollowing !== !!settings.hideOfflineFollowing);
    // Reload the list so the merge (or the normal paging) applies right away.
    if (changed) {
      refetchedFor = null;
      const list = findList();
      if (!expandOn()) list?.counter?.queue.dispatch(5);
      list?.observer.refetch();
    }
    schedule();
  });
})();
