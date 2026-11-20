// Chat replay for unlocked sub-only VODs.
//
// Kick's sub-only VOD page renders the normal right-hand chat column, just
// empty (the video is locked). We fill it with the channel's chat history,
// played back in sync with the video — the same thing Kick's own VOD chat does.
//
// Data: GET web.kick.com/api/v1/chat/<channelId>/history?start_time=<ISO> (and
// ?cursor=<c>). <channelId> is the videos-list entry's `channel_id`; messages
// carry sender.username, sender.identity.color, badges_v2[].image_url and a
// content string with [emote:<id>:<name>] tags. Messages are shown when their
// wall-clock created_at reaches (stream start + video.currentTime).
//
// ktMountSubChat(video, channelId, startMs) -> { destroy() } | null
// Approach adapted from KickNoSub (github.com/Enmn/KickNoSub, Apache-2.0).
(() => {
  const API = (id) => `https://web.kick.com/api/v1/chat/${encodeURIComponent(id)}/history`;
  const EMOTE = /\[emote:(\d+):([^\]]+)\]/g;
  const STYLE_ID = "mykick-chat-style";
  const MAX_KEEP = 500; // messages held in memory
  const MAX_SHOWN = 120; // rows in the DOM at once
  const BACKLOG_MS = 90000; // fetch starting this far behind the playhead
  const LEAD_MS = 15000; // fetch again once fewer than this many ms are buffered ahead
  const MIN_PULL_MS = 900; // min gap between history fetches
  const MAX_BACKOFF_MS = 10000; // gap after repeated fetches that brought nothing new
  const SEEK_DEBOUNCE_MS = 250;

  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      .kt-chat-root { display: flex; flex-direction: column; padding: 8px 0; font: 400 14px/1.5 Inter, system-ui, sans-serif; color: #efeff1; }
      .kt-chat-row { display: block; padding: 5px 12px; word-break: break-word; }
      .kt-chat-row:hover { background: rgba(255,255,255,.045); }
      /* Kick's Tailwind base sets img{display:block} and scopes some element
         styles inside the chat; force our parts to flow inline on one line. */
      .kt-chat-time, .kt-chat-user, .kt-chat-colon { display: inline; }
      .kt-chat-time { color: #9aa1ab; font-size: 12px; margin-right: 6px; font-variant-numeric: tabular-nums; }
      .kt-chat-badge { display: inline-block; height: 16px; width: 16px; border-radius: 3px; margin-right: 3px; vertical-align: -3px; object-fit: contain; }
      .kt-chat-user { font-weight: 700; }
      .kt-chat-colon { color: #efeff1; margin: 0 4px 0 1px; }
      .kt-chat-emote { display: inline-block; height: 24px; vertical-align: middle; margin: -2px 1px; }
      .kt-chat-note { padding: 10px 12px; color: #9aa1ab; font: 400 12px Inter, system-ui, sans-serif; }
    `;
    (document.head || document.documentElement).appendChild(st);
  };

  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(x).padStart(2, "0");
  };

  const fetchJson = (url) =>
    fetch(url, { headers: { Accept: "application/json" }, credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  const appendContent = (row, content) => {
    EMOTE.lastIndex = 0;
    let i = 0;
    let m;
    while ((m = EMOTE.exec(content))) {
      if (m.index > i) row.appendChild(document.createTextNode(content.slice(i, m.index)));
      const img = document.createElement("img");
      img.className = "kt-chat-emote";
      img.src = `https://files.kick.com/emotes/${m[1]}/fullsize`;
      img.alt = m[2];
      img.title = m[2];
      img.loading = "lazy";
      row.appendChild(img);
      i = EMOTE.lastIndex;
    }
    if (i < content.length) row.appendChild(document.createTextNode(content.slice(i)));
  };

  // Built with textContent / createElement only, so chat text can't inject HTML.
  const buildRow = (data, videoMs) => {
    const row = document.createElement("div");
    row.className = "kt-chat-row";

    const time = document.createElement("span");
    time.className = "kt-chat-time";
    time.textContent = fmtTime(videoMs);
    row.appendChild(time);

    for (const b of data.sender?.identity?.badges_v2 || []) {
      if (!b?.image_url) continue;
      const img = document.createElement("img");
      img.className = "kt-chat-badge";
      img.src = b.image_url;
      img.alt = b.text || b.name || "";
      img.title = img.alt;
      img.loading = "lazy";
      row.appendChild(img);
    }

    const user = document.createElement("span");
    user.className = "kt-chat-user";
    user.style.color = data.sender?.identity?.color || "#53fc18";
    user.textContent = data.sender?.username || "User";
    row.appendChild(user);

    const colon = document.createElement("span");
    colon.className = "kt-chat-colon";
    colon.textContent = ":";
    row.appendChild(colon);

    appendContent(row, data.content || "");
    return row;
  };

  window.ktMountSubChat = (video, channelId, startMs) => {
    const host = document.querySelector("#chatroom-messages");
    if (!host || !video || !channelId || !Number.isFinite(startMs)) return null;
    ensureStyles();
    const scroller = host.closest('[class*="overflow-y-auto"]') || host;

    const list = document.createElement("div");
    list.className = "kt-chat-root";
    const note = document.createElement("div");
    note.className = "kt-chat-note";
    note.textContent = "Loading chat replay…";
    list.appendChild(note);
    host.replaceChildren(list);

    let destroyed = false;
    let fetching = false;
    let newestHave = -Infinity; // newest message time (ms) we hold
    let session = 0; // bumped on seek to drop in-flight work
    const seen = new Set();
    let msgs = []; // { id, t, data, el? } ascending by t
    let shown = []; // the entries currently in the DOM, ascending

    const absNow = () => startMs + video.currentTime * 1000;

    // Returns how many new messages were added.
    const ingest = (arr) => {
      let added = 0;
      for (const m of arr) {
        if (!m || seen.has(m.id)) continue;
        const t = Date.parse(m.created_at);
        if (!Number.isFinite(t)) continue;
        seen.add(m.id);
        msgs.push({ id: m.id, t, data: m });
        added++;
      }
      if (!added) return 0;
      msgs.sort((a, b) => a.t - b.t);
      if (msgs.length > MAX_KEEP) for (const d of msgs.splice(0, msgs.length - MAX_KEEP)) seen.delete(d.id);
      newestHave = msgs[msgs.length - 1].t;
      return added;
    };

    // One request window: ?start_time=<when> returns ~25 messages around that
    // time; its cursor then pages that window in full. (Measured: a start_time
    // query is anchored to the time, not chainable by cursor arithmetic — so we
    // just query at the current playhead, which advances with the video and so
    // can never get stuck re-fetching the same window.)
    const windowAt = async (whenMs, mySession) => {
      const d1 = await fetchJson(`${API(channelId)}?start_time=${encodeURIComponent(new Date(whenMs).toISOString())}`);
      let batch = d1?.data?.messages || [];
      if (d1?.data?.cursor && mySession === session && !destroyed) {
        const d2 = await fetchJson(`${API(channelId)}?cursor=${encodeURIComponent(d1.data.cursor)}`);
        batch = batch.concat(d2?.data?.messages || []);
      }
      return batch;
    };

    // Pacing: a pull that brings no newer message (quiet stretch or end of chat)
    // doubles the wait before the next, up to MAX_BACKOFF_MS.
    let lastPull = 0;
    let backoff = MIN_PULL_MS;
    const pull = async (force) => {
      if (fetching || destroyed) return;
      const now = Date.now();
      if (!force && now - lastPull < backoff) return;
      lastPull = now;
      fetching = true;
      const mySession = session;
      const before = newestHave;
      try {
        const at = absNow();
        ingest(await windowAt(at, mySession));
        // On a fresh mount or seek, grab one window further back too so there is
        // some history on screen right away, not just the last few seconds.
        if (force && mySession === session && !destroyed) {
          ingest(await windowAt(at - BACKLOG_MS, mySession));
        }
        if (mySession !== session || destroyed) return;
        backoff = newestHave > before ? MIN_PULL_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
      } finally {
        fetching = false;
      }
    };

    const rowFor = (x) => (x.el ||= buildRow(x.data, x.t - startMs));

    const render = () => {
      if (destroyed) return;
      const now = absNow();
      // Fetch ahead only while the video is actually playing; a paused tab
      // makes no requests.
      if (!video.paused && now > newestHave - LEAD_MS) pull();
      let last = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].t <= now) {
          last = i;
          break;
        }
      }
      if (last < 0) return;
      const want = msgs.slice(Math.max(0, last - (MAX_SHOWN - 1)), last + 1);
      if (
        want.length === shown.length &&
        want[0] === shown[0] &&
        want[want.length - 1] === shown[shown.length - 1]
      ) {
        return; // nothing changed on screen
      }

      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      note.remove(); // "Loading chat replay…" goes once the first rows arrive
      const wantSet = new Set(want);
      const shownSet = new Set(shown);
      const lastShownT = shown.length ? shown[shown.length - 1].t : -Infinity;
      const added = want.filter((x) => !shownSet.has(x));
      if (added.every((x) => x.t >= lastShownT)) {
        // Normal playback: drop rows that scrolled out of the window from the
        // top and append only the new ones, instead of rebuilding all rows.
        for (const x of shown) if (!wantSet.has(x)) x.el?.remove();
        if (added.length) {
          const frag = document.createDocumentFragment();
          for (const x of added) frag.appendChild(rowFor(x));
          list.appendChild(frag);
        }
      } else {
        // A late fetch slotted older messages in between: rebuild once.
        list.replaceChildren(...want.map(rowFor));
      }
      shown = want;
      if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    };

    // Seeking clears the replay at once, then fetches for the new position a
    // moment later, so dragging the seek bar doesn't fire a request per step.
    let seekTimer = 0;
    const onSeek = () => {
      session++;
      msgs = [];
      seen.clear();
      shown = [];
      newestHave = -Infinity;
      backoff = MIN_PULL_MS;
      list.replaceChildren();
      clearTimeout(seekTimer);
      // If a fetch for the old position is still in flight, wait for it to
      // finish instead of skipping the fetch for the new one.
      const fetchForSeek = () => {
        if (destroyed) return;
        if (fetching) seekTimer = setTimeout(fetchForSeek, 150);
        else pull(true).then(render);
      };
      seekTimer = setTimeout(fetchForSeek, SEEK_DEBOUNCE_MS);
    };

    const onTime = () => render();
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeking", onSeek);
    // Backstop for when the <video> fires few timeupdates (e.g. buffering).
    const timer = setInterval(render, 700);

    pull(true).then(render);

    return {
      destroy() {
        destroyed = true;
        session++;
        clearInterval(timer);
        clearTimeout(seekTimer);
        video.removeEventListener("timeupdate", onTime);
        video.removeEventListener("seeking", onSeek);
        if (host.contains(list)) host.replaceChildren();
        msgs = [];
        shown = [];
        seen.clear();
      },
    };
  };
})();
