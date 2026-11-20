// "Copy link for VLC": turns the open live stream, VOD or clip into a plain
// .m3u8 URL that VLC (Media › Open Network Stream) or mpv can play.
//
// Runs in the page's origin so Kick's API calls carry the site's own cookies
// (and pass Cloudflare like the site does). The popup asks with
// { type: "get-vlc-link" } and gets { link } or { error }.
//
//   Live  /<slug>                  GET /api/v2/channels/<slug> -> playback_url
//   VOD   /<slug>/videos/<id>      older VODs: GET /api/v1/video/<id> -> source
//         /video/<id>              newer VODs: POST web.kick.com/api/v1/stream/<id>/playback
//   Clip  /<slug>/clips/<clip_id>  GET /api/v2/clips/<clip_id> -> clip.video_url
//         /<slug>?clip=<clip_id>
(() => {
  if (window.top !== window) return;

  // Top-level paths that are Kick pages, not channels.
  const NOT_CHANNELS = new Set([
    "browse", "category", "categories", "following", "search", "settings", "dashboard",
    "popout", "subscriptions", "clips", "video", "videos", "terms-of-service", "privacy-policy",
    "community-guidelines", "dmca-policy", "about", "help", "notifications", "wallet", "kicks",
  ]);

  const token = () => {
    const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  };

  const api = async (url, init = {}) => {
    const res = await fetch(url, {
      credentials: "include",
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };

  const reachable = async (url) => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  };

  // The live playback_url carries a token that expires ~10 minutes after it
  // is issued. Public channels play without it, which gives a link that keeps
  // working; the token is only kept when the bare URL is refused.
  const live = async (slug) => {
    let ch;
    try {
      ch = await api(`/api/v2/channels/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (e.status === 404) return { error: "Open a channel, VOD or clip" };
      throw e;
    }
    const name = ch.user?.username || ch.slug || slug;
    if (!ch.livestream || !ch.playback_url) return { error: `${name} is offline` };
    const bare = ch.playback_url.split("?")[0];
    const permanent = await reachable(bare);
    return {
      link: {
        kind: "Live",
        channel: name,
        title: ch.livestream.session_title || "",
        url: permanent ? bare : ch.playback_url,
        temporary: !permanent,
      },
    };
  };

  const vod = async (id, slug) => {
    // "Unlock Sub-Only Videos" on: resolve the public master the same way the
    // in-page player does. This is the only path that reaches a subscriber-only
    // VOD, and it also hands back a permanent link for ordinary VODs.
    try {
      const { unlockSubVideos } = await ktGetSettings();
      if (unlockSubVideos && typeof window.ktResolveSubVodMaster === "function") {
        const r = await window.ktResolveSubVodMaster(slug, id);
        if (r?.url) {
          return { link: { kind: "VOD", channel: r.channel || slug, title: r.title || "", url: r.url } };
        }
      }
    } catch {}

    // Older VODs (UUID ids) still have a permanent `source` on the legacy API.
    try {
      const v = await api(`/api/v1/video/${encodeURIComponent(id)}`);
      if (v.source) {
        return {
          link: {
            kind: "VOD",
            channel: v.livestream?.channel?.user?.username || v.livestream?.channel?.slug || slug,
            title: v.livestream?.session_title || "",
            url: v.source,
          },
        };
      }
    } catch {}

    // Newer VODs only come from the playback endpoint. Its `vod` URL is a
    // proxy that expires after an hour, but `thumbnail` points into the same
    // IVS recording folder as the plain HLS master:
    //   .../media/thumbnails/thumbnail-sheet-{index}.webp -> .../media/hls/master.m3u8
    const auth = token();
    const pb = await api(`https://web.kick.com/api/v1/stream/${encodeURIComponent(id)}/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth && { Authorization: `Bearer ${auth}` }) },
      body: JSON.stringify({
        video_player: {
          player: { player_name: "web", player_software: "IVS Player" },
          mux_sdk: { sdk_available: false },
          pal_sdk: { sdk_available: false, nonce: "" },
          datazoom_sdk: { sdk_available: false },
          google_ads_sdk: { sdk_available: false },
        },
        video_session: {
          page_type: "video",
          player_remote_played: false,
          enable_sampling: false,
          url_path: location.pathname.slice(1),
          autoplay_behaviour: "click",
          play_muted: false,
          viewer_connection_type: "",
        },
        user_session: {
          session_id: crypto.randomUUID(),
          player_device_id: crypto.randomUUID(),
          browser_lang: navigator.language.slice(0, 2),
          non_personalised_ads: true,
        },
      }),
    });
    const urls = pb.playback_url || {};
    const master = /\/media\/thumbnails\//.test(urls.thumbnail || "")
      ? urls.thumbnail.replace(/\/thumbnails\/[^?]*$/, "/hls/master.m3u8")
      : "";
    const permanent = master && (await reachable(master));
    const url = permanent ? master : urls.vod;
    if (!url) return { error: "Kick didn't return a video URL" };
    return { link: { kind: "VOD", channel: slug, title: "", url, temporary: !permanent } };
  };

  const clip = async (id, slug) => {
    const { clip: c } = await api(`/api/v2/clips/${encodeURIComponent(id)}`);
    const url = c?.video_url || c?.clip_url;
    if (!url) return { error: "Kick didn't return a clip URL" };
    return {
      link: {
        kind: "Clip",
        channel: c.channel?.username || c.channel?.slug || slug,
        title: c.title || "",
        url,
      },
    };
  };

  const resolve = () => {
    const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const clipParam = new URLSearchParams(location.search).get("clip");
    const [slug, section, id] = parts;

    if (parts[0] === "video" && parts[1]) return vod(parts[1], "");
    if (!slug || NOT_CHANNELS.has(slug.toLowerCase())) return { error: "Open a channel, VOD or clip" };
    if (clipParam) return clip(clipParam, slug);
    if (section === "videos" && id) return vod(id, slug);
    if (section === "clips" && id) return clip(id, slug);
    if (!section) return live(slug);
    return { error: "Open a channel, VOD or clip" };
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "get-vlc-link") return;
    Promise.resolve()
      .then(resolve)
      .catch((e) => {
        console.warn("[My'Kick] VLC link failed", e);
        return { error: e.status === 403 ? "Kick refused the request, reload the page" : "Couldn't get the link" };
      })
      .then(sendResponse);
    return true;
  });
})();
