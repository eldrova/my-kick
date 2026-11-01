// Block lists on the Browse pages.
//
// Browse > Categories (/browse/categories)
//   Card: div[data-testid="category-card-root"], name in
//   span[data-testid="category-<Name>"], cover link a[href="/category/<slug>"].
//   Tag chips (/browse?tags=...) are ignored: only the card's own category counts.
//
// Browse > Livestreams (/browse)
//   Card: div[data-testid="livestream-results-card"], cover link
//   a[data-testid="media-card-thumbnail"][href="/<channel slug>"], streamer
//   display name in the avatar's alt, category in a[href^="/category/"], stream
//   title in the last a[title][href="/<slug>"] below the cover (the first one is
//   the channel name) and in the cover image's alt.
//   Hidden when the streamer is blocked, when its category is blocked (while
//   "Block categories" is on), or when its title contains a blocked word (while
//   "Hide by title" is on; case- and accent-insensitive, see ktFoldTitle). With
//   "Keep followed streamers" on, channels the user follows are not hidden for
//   their category or title (an explicit streamer block still wins). The follow
//   list comes from src/content/follows.js.
//
// Both kinds get an optional × button on the cover that adds the card's
// category / streamer to the matching list.
(() => {
  if (window.top !== window) return;

  const BLOCKED_ATTR = "data-kt-blocked";
  const BUTTON_CLASS = "kt-block-btn";

  let s = null; // settings, null until loaded
  let blockedCategories = new Set();
  let blockedStreamers = new Set();
  let blockedTitleWords = []; // folded with ktFoldTitle
  let followed = null; // Set of normalized slugs/names, null until known
  let followedFrom = null; // the ktFollows list `followed` was built from
  let scheduled = null;

  const keysOf = (...values) => values.map(ktNormalize).filter(Boolean);
  const text = (el) => el?.textContent.trim() || "";
  // "/eray" -> "eray"
  const channelSlug = (a) => a?.getAttribute("href")?.split(/[/?#]/)[1] || "";
  // "/category/just-chatting" -> "just-chatting"
  const categorySlug = (a) => a?.getAttribute("href")?.split(/[?#]/)[0].split("/")[2] || "";

  const categoryCard = {
    path: /^\/browse\/categories\/?$/,
    card: 'div[data-testid="category-card-root"]',
    cover: 'a[href^="/category/"]',
    name: (card) => text(card.querySelector('span[data-testid^="category-"]')),
    keys(card) {
      return keysOf(this.name(card), categorySlug(card.querySelector(this.cover)));
    },
    isBlocked(card) {
      return !!s.blockCategories && this.keys(card).some((k) => blockedCategories.has(k));
    },
    showButton: () => !!s.blockCategories && !!s.showBlockButtons,
    listKey: "blockedCategories",
  };

  const streamCard = {
    path: /^\/browse\/?$/,
    card: 'div[data-testid="livestream-results-card"]',
    cover: 'a[data-testid="media-card-thumbnail"]',
    name(card) {
      const slug = channelSlug(card.querySelector(this.cover));
      // The cover link has the same href, but its image alt is the stream title.
      const avatar = card.querySelector(`a[href="/${CSS.escape(slug)}"]:not(${this.cover}) img[alt]`);
      return avatar?.getAttribute("alt").trim() || slug;
    },
    keys(card) {
      return keysOf(this.name(card), channelSlug(card.querySelector(this.cover)));
    },
    categoryKeys(card) {
      const link = card.querySelector('a[href^="/category/"]');
      return keysOf(text(link), categorySlug(link));
    },
    title(card) {
      const cover = card.querySelector(this.cover);
      const links = card.querySelectorAll(`a[title][href="/${CSS.escape(channelSlug(cover))}"]:not(${this.cover})`);
      if (links.length > 1) return links[links.length - 1].title;
      return cover?.querySelector('img[alt]:not([alt=""])')?.alt || "";
    },
    hasBlockedTitle(card) {
      if (!s.blockTitles || !blockedTitleWords.length) return false;
      const title = ktFoldTitle(this.title(card));
      return !!title && blockedTitleWords.some((w) => title.includes(w));
    },
    isBlocked(card) {
      const keys = this.keys(card);
      if (s.blockStreamers && keys.some((k) => blockedStreamers.has(k))) return true;
      const byCategory = s.blockCategories && this.categoryKeys(card).some((k) => blockedCategories.has(k));
      if (!byCategory && !this.hasBlockedTitle(card)) return false;
      if (!s.keepFollowedInBlockedCategories) return true;
      // Until the follow list has loaded we can't tell, so keep the card hidden.
      return !followed || !keys.some((k) => followed.has(k));
    },
    showButton: () => !!s.blockStreamers && !!s.showStreamerBlockButtons,
    listKey: "blockedStreamers",
  };

  const KINDS = [categoryCard, streamCard];

  const style = document.createElement("style");
  style.textContent = `
    [${BLOCKED_ATTR}] { display: none !important; }
    .${BUTTON_CLASS} {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 50;
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(11, 14, 15, 0.75);
      color: #fff;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.15s, background 0.15s, transform 0.1s;
    }
    .${BUTTON_CLASS}:hover { opacity: 1; background: #e5484d; }
    .${BUTTON_CLASS}:active { transform: scale(0.92); }
    .${BUTTON_CLASS} svg { width: 12px; height: 12px; pointer-events: none; }
  `;
  (document.head || document.documentElement).appendChild(style);

  const addToList = async (listKey, name) => {
    const key = ktNormalize(name);
    if (!key) return;
    const list = (await ktGetSettings())[listKey] || [];
    if (!list.some((n) => ktNormalize(n) === key)) await ktSetSetting(listKey, [...list, name]);
  };

  const makeButton = (kind, card) => {
    const name = kind.name(card);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BUTTON_CLASS;
    btn.title = `Block ${name}`;
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML =
      '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<path d="M2 2l8 8M10 2l-8 8"/></svg>';
    // The button sits inside the card's cover link: don't let the click
    // navigate or reach Kick's handlers.
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    btn.addEventListener("pointerdown", stop);
    btn.addEventListener("mousedown", stop);
    btn.addEventListener("click", (e) => {
      stop(e);
      card.toggleAttribute(BLOCKED_ATTR, true); // hide right away
      addToList(kind.listKey, kind.name(card));
    });
    return btn;
  };

  // Uses whatever list ktFollows has right now (the stored copy at page load),
  // so followed channels are never hidden first and shown later. get() also
  // starts a background refresh when the list is old, or the first fetch if
  // there is none yet; onChange() below re-runs update when it lands.
  const syncFollows = () => {
    const list = ktFollows.peek();
    if (list && list !== followedFrom) {
      followed = new Set(keysOf(...list.flatMap((c) => [c.channel_slug, c.user_username])));
      followedFrom = list;
    }
    ktFollows.get().then((fresh) => fresh !== followedFrom && schedule());
  };
  ktFollows.onChange(() => schedule());

  const update = () => {
    scheduled = null;
    if (!s) return;
    if (
      streamCard.path.test(location.pathname) &&
      (s.blockCategories || s.blockTitles) &&
      s.keepFollowedInBlockedCategories
    ) {
      syncFollows();
    }
    for (const kind of KINDS) {
      const onPage = kind.path.test(location.pathname);
      const buttons = onPage && kind.showButton();
      for (const card of document.querySelectorAll(kind.card)) {
        card.toggleAttribute(BLOCKED_ATTR, onPage && kind.isBlocked(card));
        const cover = card.querySelector(kind.cover);
        const existing = cover?.querySelector(`.${BUTTON_CLASS}`);
        if (buttons && cover && !existing) cover.appendChild(makeButton(kind, card));
        else if (!buttons && existing) existing.remove();
      }
    }
  };

  const schedule = () => {
    if (!scheduled) scheduled = setTimeout(update, 50);
  };

  // More cards load while scrolling, and Kick navigates without page loads.
  // Elsewhere (channel pages with a busy chat) there is nothing to do; the
  // cards and our buttons unmount with the Browse page itself.
  const onBrowsePage = () => KINDS.some((kind) => kind.path.test(location.pathname));
  new MutationObserver(() => onBrowsePage() && schedule()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  const applySettings = (next) => {
    s = next;
    blockedCategories = new Set(keysOf(...(s.blockedCategories || [])));
    blockedStreamers = new Set(keysOf(...(s.blockedStreamers || [])));
    blockedTitleWords = (s.blockedTitleWords || []).map(ktFoldTitle).filter(Boolean);
    schedule();
  };

  // Don't decide anything before the stored follow list has been read.
  Promise.all([ktGetSettings(), ktFollows.ready]).then(([settings]) => applySettings(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) ktGetSettings().then(applySettings);
  });
})();
