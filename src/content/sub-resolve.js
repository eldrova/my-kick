// Resolves a subscriber-only Kick VOD to a plain .m3u8 master playlist URL.
//
// Shared by the sub-only player (src/content/sub-unlock.js) and the VLC-link
// copier (src/content/vlc-link.js). Runs in the isolated content-script world,
// so its fetches use the extension's own context (not the page CSP) while still
// sending kick.com's cookies with credentials:"include".
//
// How it works. Kick's channel videos list (/api/v2/channels/<slug>/videos)
// returns every VOD, sub-only ones included, each with a `thumbnail` that still
// embeds the IVS recording path <channelIvsId>/<videoId> and a `start_time`.
// The public HLS master lives at a fixed, unauthenticated location derived from
// those two ids plus the minute the stream started:
//   https://stream.kick.com[/<edge>]/ivs/v1/196233775518
//        /<channelIvsId>/<Y>/<M>/<D>/<h>/<min>/<videoId>/media/hls/master.m3u8
// (date parts are NOT zero-padded). We find the list entry for the open video,
// read its thumbnail ids + start_time, and probe a few minute offsets and edge
// prefixes until one returns 200. No subscription token is involved.
//
// Technique adapted from KickNoSub (github.com/Enmn/KickNoSub, Apache-2.0).
(() => {
  const CUSTOMER_ID = "196233775518";
  const BASES = [
    `https://stream.kick.com/3c81249a5ce0/ivs/v1/${CUSTOMER_ID}`,
    `https://stream.kick.com/ivs/v1/${CUSTOMER_ID}`,
    `https://stream.kick.com/0f3cb0ebce7/ivs/v1/${CUSTOMER_ID}`,
  ];
  const OFFSETS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];

  // In-memory cache: videoSlug -> Promise<{ url, title, channel } | null>.
  // Capped so a long session browsing many VODs can't grow it without bound.
  const cache = new Map();
  const CACHE_MAX = 50;

  // Reads a JSON body even on a non-2xx response (the sub-only /api/v1/video
  // endpoint answers 403 but still carries start_time + channel we can use).
  const fetchBody = async (url) => {
    try {
      const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  };

  // Probe a playlist URL. Only the status matters, so drop the body right away
  // instead of leaving the response stream open.
  const headOk = async (url) => {
    try {
      const res = await fetch(url);
      res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  };

  const parseUtc = (value) => {
    if (!value) return null;
    let text = String(value).replace(" ", "T");
    if (!/[+Z]/.test(text.slice(10))) text += "Z";
    const d = new Date(text);
    return isNaN(d.getTime()) ? null : d;
  };

  const minuteKey = (value) => {
    const d = parseUtc(value);
    return d ? Math.floor(d.getTime() / 60000) : null;
  };

  // Kick's VOD page ids (the <id> in /<channel>/videos/<id>) are now UUIDv7,
  // whose first 48 bits are the stream's start time in Unix ms. These ids are
  // NOT in the videos list and /api/v1/video/<id> 404s for them, so this is the
  // only reliable way to map the open page to its list entry (by start minute).
  // Returns null for other id forms (e.g. legacy UUIDv4, whose version is 4).
  const uuidV7Ms = (id) => {
    const hex = String(id || "").replace(/-/g, "");
    if (hex.length < 13 || hex[12] !== "7") return null; // 13th hex digit = version
    const ms = parseInt(hex.slice(0, 12), 16);
    return Number.isFinite(ms) && ms > 1e12 ? ms : null; // sane only after ~2001
  };

  const str = (v) => String(v ?? "").toLowerCase();

  // Finds the videos-list entry for the open video. Kick uses several id forms
  // (page UUIDv7, legacy video.uuid, numeric id, title slug), so we try exact
  // matches on each, then a loose substring match either way.
  const matchEntry = (list, videoSlug) => {
    const target = str(videoSlug).trim();
    if (!target) return null;
    const ids = (e) => [e?.video?.uuid, e?.video?.id, e?.uuid, e?.id, e?.slug].map(str);
    let hit = list.find((e) => ids(e).some((v) => v && v === target));
    if (hit) return hit;
    if (target.length > 5) {
      hit = list.find((e) => {
        try {
          return JSON.stringify(e).toLowerCase().includes(target);
        } catch {
          return false;
        }
      });
    }
    return hit || null;
  };

  // thumbnail.src looks like
  //   https://images.kick.com/video_thumbnails/<cid>/<vid>/720.webp?...
  // or a full IVS path that contains .../ivs/v1/<cid>/<vid>/...
  const idsFromThumb = (thumb) => {
    const src = typeof thumb === "string" ? thumb : thumb?.src || thumb?.url || "";
    if (!src) return null;
    const parts = src.split(/[/?]/);
    const ivs = parts.indexOf("ivs");
    if (ivs !== -1 && parts[ivs + 1] === "v1" && parts[ivs + 3]) {
      return { cid: parts[ivs + 3], vid: parts[ivs + 4] };
    }
    // .../video_thumbnails/<cid>/<vid>/...
    const vt = parts.indexOf("video_thumbnails");
    if (vt !== -1 && parts[vt + 1] && parts[vt + 2]) return { cid: parts[vt + 1], vid: parts[vt + 2] };
    return null;
  };

  const buildMaster = async (ids, startTime) => {
    const d = parseUtc(startTime);
    if (!d || !ids?.cid || !ids?.vid) return null;
    for (const off of OFFSETS) {
      const t = new Date(d.getTime() + off * 60000);
      const path = [
        ids.cid,
        t.getUTCFullYear(),
        t.getUTCMonth() + 1,
        t.getUTCDate(),
        t.getUTCHours(),
        t.getUTCMinutes(),
        ids.vid,
      ].join("/");
      for (const base of BASES) {
        const url = `${base}/${path}/media/hls/master.m3u8`;
        if (await headOk(url)) return url;
      }
    }
    return null;
  };

  const resolve = async (channelSlug, videoSlug) => {
    if (!videoSlug) return null;

    let startHint = null;
    // When the channel isn't in the URL (/video/<id> pages), learn it (and a
    // start_time) from the single-video endpoint, which answers even for
    // sub-only videos.
    if (!channelSlug) {
      const v = await fetchBody(`/api/v1/video/${encodeURIComponent(videoSlug)}`);
      channelSlug = v?.livestream?.channel?.slug || v?.channel?.slug || v?.channel_slug || "";
      startHint = v?.start_time || v?.livestream?.start_time || null;
    }
    if (!channelSlug) return null;

    const list = await fetchBody(`/api/v2/channels/${encodeURIComponent(channelSlug)}/videos`);
    const arr = Array.isArray(list) ? list : [];

    let entry = matchEntry(arr, videoSlug);
    if (!entry) {
      // Prefer the UUIDv7 start time embedded in the page id (no network, exact).
      // Fall back to the single-video endpoint's start_time for legacy ids.
      let startMs = uuidV7Ms(videoSlug);
      if (startMs == null) {
        if (!startHint) {
          const v = await fetchBody(`/api/v1/video/${encodeURIComponent(videoSlug)}`);
          startHint = v?.start_time || v?.livestream?.start_time || null;
        }
        const d = parseUtc(startHint);
        startMs = d ? d.getTime() : null;
      }
      if (startMs != null) {
        const key = Math.floor(startMs / 60000);
        entry = arr.find((e) => minuteKey(e.start_time) === key) || null;
      }
    }
    if (!entry) return null;

    // channelId + startMs let the chat replay (src/content/sub-chat.js) pull the
    // matching chat history and sync it to the video.
    const meta = {
      title: entry.session_title || "",
      channel: channelSlug,
      channelId: entry.channel_id || null,
      startMs: parseUtc(entry.start_time)?.getTime() ?? null,
    };

    // Public VODs already expose a permanent master in `source`.
    if (entry.source) return { url: entry.source, ...meta };

    const ids = idsFromThumb(entry.thumbnail);
    const url = await buildMaster(ids, entry.start_time);
    return url ? { url, ...meta } : null;
  };

  // Public entry point. Memoised per video so the player and the VLC button
  // don't probe twice.
  window.ktResolveSubVodMaster = (channelSlug, videoSlug) => {
    const key = videoSlug || "";
    if (cache.has(key)) return cache.get(key);
    const p = resolve(channelSlug, videoSlug).catch(() => null);
    cache.set(key, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // drop the oldest
    p.then((v) => {
      if (!v) cache.delete(key); // allow a retry after a transient failure
    });
    return p;
  };
})();
