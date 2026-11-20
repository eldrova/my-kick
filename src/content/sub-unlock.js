// "Unlock Sub-Only Videos" (Premium): when the setting is on and a Kick VOD
// page shows the subscriber-only lock, replace the lock with a working HLS
// player. The stream URL comes from the shared resolver (src/content/sub-
// resolve.js); playback uses hls.js (src/vendor/hls.min.mjs).
//
// Cost when not in use: none. The DOM observer only runs while the setting is
// on, only looks for the lock on VOD routes, and hls.js (~430 KB) is imported
// only the first time a locked VOD is actually opened, not on every Kick page.
//
// We overlay the player on top of Kick's own player instead of wiping it, so
// React keeps managing the page. Only one player exists at a time: a new mount,
// a navigation, the setting turning off, or React dropping our node all tear
// the previous one down (hls.destroy() stops its network and frees its buffers).
//
// Unlock technique adapted from KickNoSub (github.com/Enmn/KickNoSub,
// Apache-2.0).
(() => {
  if (window.top !== window) return; // top frame only, where the main player is

  const SEL_OVERLAY = '[data-testid="video-subscriber-only"]';
  const SEL_CONTAINER = ".relative.flex.flex-col";
  const FONT = "Inter, system-ui, sans-serif";
  const HLS_URL = chrome.runtime.getURL("src/vendor/hls.min.mjs");
  // Fatal hls.js errors we try to recover from before giving up. hls.js has its
  // own retries underneath; without a cap a dead stream would retry forever.
  const MAX_FATAL_RETRIES = 3;

  let enabled = false;
  let observer = null;
  let hls = null;
  let chat = null; // chat-replay controller (src/content/sub-chat.js)
  let overlayEl = null; // our <div> that holds the player
  let host = null; // the clipping viewport box we append the overlay to
  let setPosition = false; // whether we wrote host.style.position ourselves
  let guard = null; // the aspect box that carries the data-mykickUnlock marker
  let lastHref = location.href;
  let hlsModule = null; // Promise<Hls class>, created on first use

  const loadHls = () =>
    (hlsModule ||= import(HLS_URL)
      .then((m) => m.default)
      .catch((e) => {
        hlsModule = null; // allow a retry later
        throw e;
      }));

  const teardown = () => {
    try {
      chat?.destroy();
    } catch {}
    chat = null;
    try {
      hls?.destroy();
    } catch {}
    hls = null;
    if (overlayEl?.isConnected) overlayEl.remove();
    overlayEl = null;
    if (host && setPosition) host.style.position = "";
    host = null;
    setPosition = false;
    if (guard) {
      delete guard.dataset.mykickUnlock;
      guard = null;
    }
  };

  const parseRoute = () => {
    const p = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (p[0] === "video" && p[1]) return { channel: "", video: p[1] };
    if (p.length >= 3 && (p[1] === "videos" || p[1] === "video")) return { channel: p[0], video: p[2] };
    return null;
  };

  const banner = (text, color) =>
    `<div style="color:${color};font:600 14px ${FONT};text-align:center;padding:0 16px;">${text}</div>`;

  // Entrance motion: the overlay crossfades in over Kick's lock, the video
  // fades/scales up when it starts, and a one-shot pill tells the viewer the
  // unlock happened. All disabled under prefers-reduced-motion.
  const STYLE_ID = "mykick-unlock-style";
  const ensureStyles = () => {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      @keyframes mykickFadeIn { from { opacity: 0 } to { opacity: 1 } }
      @keyframes mykickPillIn { from { opacity: 0; transform: translate(-50%, -10px) } to { opacity: 1; transform: translate(-50%, 0) } }
      .mykick-unlock { animation: mykickFadeIn 380ms cubic-bezier(.22,1,.36,1) both; }
      .mykick-unlock video { opacity: 0; transform: scale(1.03); transition: opacity .5s ease, transform .6s cubic-bezier(.22,1,.36,1); }
      .mykick-unlock video.mykick-playing { opacity: 1; transform: scale(1); }
      .mykick-pill {
        position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2;
        display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
        padding: 6px 13px; border-radius: 999px;
        background: rgba(11,14,15,.82); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
        color: #fff; font: 600 12px ${FONT}; letter-spacing: .2px;
        border: 1px solid rgba(83,252,24,.4); box-shadow: 0 4px 16px rgba(0,0,0,.45);
        animation: mykickPillIn 440ms cubic-bezier(.22,1,.36,1) both;
      }
      .mykick-pill b { color: #53fc18; font-weight: 800; }
      .mykick-pill.mykick-pill-hide { opacity: 0; transform: translate(-50%, -10px); transition: opacity .55s ease, transform .55s ease; }
      @media (prefers-reduced-motion: reduce) {
        .mykick-unlock, .mykick-unlock video, .mykick-pill { animation: none !important; transition: none !important; opacity: 1 !important; transform: none !important; }
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  };

  // Brief "Unlocked Sub-Only Video" badge, top-center, that fades itself out.
  const showUnlockedPill = (root) => {
    if (!root || !root.isConnected || root.querySelector(".mykick-pill")) return;
    const pill = document.createElement("div");
    pill.className = "mykick-pill";
    // One span so the pill's flex `gap` doesn't push a space before <b>Kick</b>.
    // "Kick" is green (the b rule), so it reads as the My'Kick brand.
    pill.innerHTML = "<span>🔓 Sub-Only Video unlocked by My'<b>Kick</b></span>";
    root.appendChild(pill);
    setTimeout(() => {
      if (!pill.isConnected) return;
      pill.classList.add("mykick-pill-hide");
      setTimeout(() => pill.remove(), 600);
    }, 10000);
  };

  const mount = async (overlay) => {
    const aspect = overlay.closest(SEL_CONTAINER);
    if (!aspect || aspect.dataset.mykickUnlock) return;
    const route = parseRoute();
    if (!route) return;

    // One player at a time: drop any previous one (Kick re-rendered its
    // container, or the last resolve was still running when we navigated).
    teardown();
    ensureStyles();

    aspect.dataset.mykickUnlock = "loading";
    guard = aspect;

    // Kick clips the player to a max-height viewport that is shorter than the
    // 16:9 aspect box. Mounting on the aspect box would push our control bar
    // below that clip, where it is cut off and hidden behind the content under
    // the player. Mount on the clipping viewport instead so the whole player
    // (controls included) stays visible.
    host = aspect;
    for (let el = aspect; el && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflow !== "visible" && el.clientHeight + 2 < el.scrollHeight) {
        host = el;
        break;
      }
    }
    if (getComputedStyle(host).position === "static") {
      host.style.position = "relative";
      setPosition = true;
    }

    const mine = document.createElement("div");
    mine.className = "mykick-unlock";
    // z-index 250 puts the player in Kick's own control layer: above the lock
    // (z 101) and the content below, but under the navbar (301) and popovers
    // (401+), so page UI still overlays the player.
    mine.setAttribute(
      "style",
      "position:absolute;inset:0;z-index:250;background:#000;display:flex;align-items:center;justify-content:center;"
    );
    mine.innerHTML = banner("My'Kick · unlocking…", "#53fc18");
    overlayEl = mine;
    host.appendChild(mine);

    // Resolve the stream and load hls.js in parallel.
    const [res, Hls] = await Promise.all([
      Promise.resolve()
        .then(() => window.ktResolveSubVodMaster(route.channel, route.video))
        .catch(() => null),
      loadHls().catch(() => null),
    ]);
    // Superseded by a newer mount, or torn down while we were waiting.
    if (overlayEl !== mine || !mine.isConnected) return;

    if (!res?.url) {
      mine.innerHTML = banner("My'Kick couldn't unlock this video", "#ff5a5a");
      guard.dataset.mykickUnlock = "failed";
      return;
    }

    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("style", "width:100%;height:100%;background:#000;object-fit:contain;");
    mine.innerHTML = "";
    mine.appendChild(video);

    // Reveal the video (fade + scale) and flash the pill the moment playback
    // actually starts, so the viewer sees the feature kick in.
    video.addEventListener(
      "playing",
      () => {
        video.classList.add("mykick-playing");
        showUnlockedPill(mine);
      },
      { once: true }
    );

    const src = res.url + (res.url.includes("?") ? "&" : "?") + "mykick=" + Date.now();
    if (Hls && Hls.isSupported()) {
      // backBufferLength: keep only the last 60 s already played. hls.js keeps
      // everything by default (Infinity), so an 8-hour VOD would hold buffers
      // at the browser's cap for the whole session.
      // startLevel -1 lets hls.js show the first frame fast; MANIFEST_PARSED
      // below then locks it to the source rendition.
      const h = new Hls({ enableWorker: false, backBufferLength: 60 });
      hls = h;
      let fatal = 0;
      // Always play the highest-resolution rendition (source), never ABR auto.
      // Setting currentLevel pins it, so it won't drop quality on a dip; it
      // re-asserts if the rendition list ever changes.
      const lockToSource = () => {
        const levels = h.levels || [];
        if (levels.length < 2) return;
        let best = 0;
        for (let i = 1; i < levels.length; i++) {
          const a = levels[i];
          const b = levels[best];
          const ah = a.height || 0;
          const bh = b.height || 0;
          if (ah > bh || (ah === bh && (a.bitrate || 0) > (b.bitrate || 0))) best = i;
        }
        if (h.currentLevel !== best) h.currentLevel = best;
      };
      h.on(Hls.Events.MANIFEST_PARSED, lockToSource);
      h.on(Hls.Events.LEVELS_UPDATED, lockToSource);
      h.on(Hls.Events.FRAG_LOADED, () => {
        fatal = 0;
      });
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) return;
        if (++fatal <= MAX_FATAL_RETRIES) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return h.startLoad();
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return h.recoverMediaError();
        }
        try {
          h.destroy();
        } catch {}
        if (hls === h) hls = null;
        if (overlayEl === mine && mine.isConnected) mine.innerHTML = banner("My'Kick · playback failed", "#ff5a5a");
      });
      h.loadSource(src);
      h.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else {
      mine.innerHTML = banner(
        Hls ? "My'Kick · this browser can't play HLS" : "My'Kick · couldn't load the player",
        "#ff5a5a"
      );
      guard.dataset.mykickUnlock = "failed";
      return;
    }

    // Play the channel's chat history back in Kick's own chat column, synced to
    // the video (same as a normal VOD). Safe to skip if the data is missing.
    if (window.ktMountSubChat && res.channelId && res.startMs) {
      try {
        chat = window.ktMountSubChat(video, res.channelId, res.startMs);
      } catch {}
    }

    guard.dataset.mykickUnlock = "done";
  };

  const scan = () => {
    if (!enabled || !parseRoute()) return; // only VOD routes can have the lock
    const overlay = document.querySelector(SEL_OVERLAY);
    if (!overlay) return;
    const container = overlay.closest(SEL_CONTAINER);
    if (container && !container.dataset.mykickUnlock) mount(overlay);
  };

  const onMutations = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      teardown();
    } else if (overlayEl && !overlayEl.isConnected) {
      teardown(); // React removed our node; the next scan mounts again
    }
    scan();
  };

  // The observer exists only while the setting is on.
  const apply = (settings) => {
    const next = !!settings.unlockSubVideos;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      lastHref = location.href;
      observer ||= new MutationObserver(onMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      scan();
    } else {
      observer?.disconnect();
      teardown();
    }
  };

  // ktGetSettings is a top-level const from settings.js, shared across the
  // extension's content scripts in this isolated world.
  ktGetSettings().then(apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) ktGetSettings().then(apply);
  });
})();
