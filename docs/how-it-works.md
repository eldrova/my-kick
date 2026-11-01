# How it works

Technical notes on Filtered Kick (My'Kick).

## Lock stream quality
Kick uses the Amazon IVS player:
- On player `READY` it reads `sessionStorage.stream_quality` (a height). If a rendition with that height exists it calls `setQuality()`, otherwise `setAutoQualityMode(true)`.
- On every new stream it clears that value if it is 1080 or higher, so a 1080p choice is never remembered.
- In Auto mode the ceiling on desktop is **720p** (1080p only in TV mode).

`src/inject/quality-lock.js` runs in the page's MAIN world at `document_start` and catches the player's `setAutoQualityMode`. While the lock is on, "switch to Auto" becomes "select the highest rendition".

## Turbo switching (`fastStreamSwitch`)
Before calling `player.load()` for a new stream, Kick waits for `isLoadingPlayback` to clear, which needs two ad SDK checks to settle one after the other: `useDatazoomPreflight` (Datazoom, `fnWithTimeout` 4 s) and then `usePalNonce` (Google PAL, 2 s). Both SDK loaders look for an existing `<script src="...">` first and wait for its `load`/`error` event. When an ad blocker blocks the SDK, the tag from the first attempt stays in the page in a failed state, so on every later switch the loader waits for an event that never fires and hits both timeouts (~6 s).

`src/content/fast-switch.js` listens for script `error` events (capture phase on `window`) and removes failed SDK tags (`imasdk.googleapis.com`, `kick.com/datazoom/`). The next attempt creates a fresh tag, which fails immediately, and playback starts without waiting. Measured on a live channel switch: click → first frame ~7.2 s before, ~1.6 s after. Without an ad blocker the scripts load normally and nothing is removed.

## Copy link for VLC
`src/content/vlc-link.js` (top frame only) answers the popup's `get-vlc-link` message. It runs in the page's origin, so Kick's API calls carry the site's own cookies and pass Cloudflare like the site does.

- **Live** (`/<slug>`): `GET /api/v2/channels/<slug>` → `playback_url`, an IVS master playlist with a `?token=` that expires ~10 minutes after it is issued. Public channels play without the token, so the bare URL is checked and copied when it works; that link keeps working for as long as the channel is live. Offline → `livestream` is null.
- **VOD** (`/<slug>/videos/<id>`, `/video/<id>`): older VODs (UUID ids) have a permanent `source` on `GET /api/v1/video/<id>`. Newer VODs return 404 there and only come from `POST web.kick.com/api/v1/stream/<id>/playback` (the body is the player/session info the site sends). Its `playback_url.vod` is a proxy that expires after an hour, but `playback_url.thumbnail` points into the same IVS recording folder: `.../media/thumbnails/thumbnail-sheet-{index}.webp` → `.../media/hls/master.m3u8` is the plain, permanent master playlist. The `vod` URL is only used when that doesn't load.
- **Clip** (`/<slug>/clips/<clip_id>`, `?clip=<clip_id>`): `GET /api/v2/clips/<clip_id>` → `clip.video_url`.

Links that still carry a token are flagged `temporary`, and the popup says to open them soon. The popup also shows the link in a read-only field in case the clipboard write fails.

## Following sidebar
`/api/v2/channels/followed` returns 5 channels per page, live channels first (by viewers), then offline. The sidebar shows 5 rows and each "Show More" click adds 5 (fetching the next page when needed).

The server always returns 5 per page, but the cursor is a plain offset, so pages can be fetched in parallel.

`src/inject/following-expand.js` (MAIN world) expands the list without clicks:
1. It wraps `fetch`. When Kick requests the first page, it fetches all pages in parallel batches and returns them as a single page with `nextCursor: null`. Kick's own 5-minute refetch goes through the same path, so newly live channels show up and the list stays complete. With "Hide offline channels" on it stops after the first batch that contains an offline channel.
2. Through React's fiber it sets the list's row counter (a `useState(5)`) to a large number, so every row renders at once.

When a toggle changes, it calls the list query's `refetch()` so the change applies right away.

`src/content/following.js` hides the Show More / Show Less bar and marks offline rows (no category line, no green live dot) so CSS can hide them.

## Auto-accept chat rules
Accepting chat rules is purely client-side, there is no API call:
- The rules come from `GET web.kick.com/api/v1/channels/{id}/chat/settings` (`data.rules`).
- "I agree" stores `{ chatroomId: id, hash: hash(rules) }` in `localStorage.accepted_chat_rules` (Java-style string hash). The box is skipped when the channel has an entry with a matching hash, so it comes back if the rules change.

`src/inject/chat-rules.js` (MAIN world) catches the settings response and writes that entry before Kick reads it, so the box never opens. It also fires Mantine's `mantine-local-storage` event, which updates an already mounted chat, so turning the toggle on closes a box that is already open.

## Keep deleted messages
Chat events come over the Centrifugo WebSocket (`wss://realtime.<region>.platform.kick.com/connection/websocket`, channel `chatrooms.<id>.v2`). A deletion is `App\Events\MessageDeletedEvent` with `{ id, message: { id }, aiModerated, violatedRules }`.

Kick never really removes the message: `handleDeleteChatMessageEvent` in the chat store sets `ui_metadata.deleted` to `"mod_deleted"` when `userCanModerate` is true, otherwise `"user_deleted"`. The message row renders `mod_deleted` as the original text struck through + "(Deleted)" (+ "AI Mod" badge and rule), and `user_deleted` as "Deleted by a moderator". `handleBanUserEvent` likewise marks a banned user's messages "(Banned)" / "(Timed out)" for moderators but removes them for everyone else.

`src/inject/chat-deleted.js` (MAIN world) makes `userCanModerate` read true only while one of those two handlers runs, so Kick picks its moderator display. The store copies its state with `Object.assign` on every update, so setters on `Object.prototype` for `userCanModerate`, `handleDeleteChatMessageEvent` and `handleBanUserEvent` install the wrapped versions on each copy. The real `userCanModerate` value is never changed. Messages deleted before you opened the chat come from the server with their text already replaced ("Deleted by a moderator"), so the original can't be shown.

In moderator mode `handleBanUserEvent` also calls `addEntry()` with a `MOD_ACTION` entry (`<mod> timed out <user> for 30 minutes`). Viewers never got that line, so the wrapped `addEntry` drops it while the ban handler runs in forced moderator mode, unless "Show ban notices" is on. Real moderators still get it.

`src/content/chat-deleted-style.js` restyles that moderator look: no strikethrough, badges/username/message at 45% opacity, a faint red row background, and the " (Deleted)" text hidden while the "AI Mod" / rule badges inside the same span stay visible. It's plain CSS with `:has()` (works with the virtualized chat that recycles rows); only the "(Deleted)" label is found by a script, since CSS can't tell it apart from "(Banned)" by text.

## Block categories and streamers
`src/content/blocking.js` handles both Browse pages. Names, slugs and every blocked entry are normalized the same way (lowercase, only letters and digits) before comparing. Cards loaded while scrolling are handled by a MutationObserver.

- **Browse › Categories** (`/browse/categories`): each card is `div[data-testid="category-card-root"]`, with the name in `span[data-testid="category-<Name>"]` and a link to `/category/<slug>`. Tag chips (`/browse?tags=...`) are ignored.
- **Browse › Livestreams** (`/browse`): each card is `div[data-testid="livestream-results-card"]`. The channel slug comes from the cover link `a[data-testid="media-card-thumbnail"]` (`/<slug>`), the display name from the avatar's `alt`, and the category from `a[href^="/category/"]` (its text, since slugs can be odd like `rv-there-yet--1`). The stream title is in two places: below the cover there are two `a[title][href="/<slug>"]` links, the channel name and then the title, and the cover images' `alt` is the title too (the second link is used, the `alt` is the fallback). A card is hidden if its streamer is blocked, or its category is blocked while "Block categories" is on, or its title contains a blocked word while "Hide by title" is on, unless (for category and title) "Keep followed streamers" is on and the user follows that channel.

Title words are compared with `ktFoldTitle` (`src/shared/settings.js`): lowercase, accents removed (NFKD), `ı` → `i`, whitespace collapsed. Unlike `ktNormalize` it keeps spaces, punctuation and non-Latin letters, so phrases and Turkish words work, and the check is a plain substring match.

## Follow list
`src/content/follows.js` loads the user's full follow list from `GET /api/v2/channels/followed-page?cursor=N` (20 channels per page, live first, `nextCursor` until the end; fields: `channel_slug`, `user_username`, `is_live`, `category_name`, `viewer_count`, `profile_picture`, `banner_picture`). The endpoint needs the `session_token` cookie sent as `Authorization: Bearer ...`; cookies alone return 401. The list (slugs and names only) is also stored in `chrome.storage.local`. On page load `blocking.js` waits for that stored copy before making any decision, so followed channels are never hidden first and shown again later; the fresh list is fetched in the background when the stored one is older than 2 minutes. Only the very first load, with nothing stored yet, has to wait for the network.

Other follow-related endpoints: `/api/v2/channels/followed` (same list, 5 per page, used by the sidebar), `/api/v1/user/livestreams` (only live followed channels, with title, categories, tags, thumbnail), `/api/v1/user/categories/top` (followed categories). `/api/v1/channels/followed` is not a follow list: it resolves "followed" as a channel slug.

The block button is added inside the card's cover link. Its click handler calls `preventDefault()` and `stopPropagation()` so the click neither follows the link nor reaches Kick's React handlers, then adds the card's category or streamer name to `blockedCategories` / `blockedStreamers`.

## Project layout

```
manifest.json
src/inject/quality-lock.js   MAIN world, IVS player hook
src/inject/following-expand.js  MAIN world, loads the whole Following list at once
src/inject/chat-rules.js     MAIN world, auto-accepts chat rules
src/inject/chat-deleted.js   MAIN world, keeps deleted chat messages visible
src/content/bridge.js        passes settings to the page, reports player status to the popup
src/content/fast-switch.js   removes failed ad SDK scripts so stream switches don't wait
src/content/chat-deleted-style.js  look of kept deleted messages (dimmed, red tint)
src/content/following.js     hides the Show More/Less bar and offline rows
src/content/follows.js       loads and caches the user's full follow list
src/content/blocking.js      category / streamer block lists on the Browse pages
src/content/vlc-link.js      resolves the tab's stream / VOD / clip to an .m3u8 link for VLC
src/shared/settings.js       default settings (add new feature flags here), name/title matching, backup helpers
src/popup/                   popup UI
src/options/                 options page: backup & restore
```

To add a feature: add a key to `KT_DEFAULT_SETTINGS`, add a `.feature` row with `data-setting="<key>"` to `popup.html` (use `data-requires="<parent key>"` for a sub-option), and read the setting in a content script. Several rows can share one `data-setting` (each needs its own `id`); the popup keeps them in step.

Every feature applies live when switched on, except ones that can only work from page load. Mark those inputs with `data-reload-on-enable`: turning them on reloads the active Kick tab. Currently that's only Turbo switching, because a page that ran without it already holds failed ad SDK tags and a stuck PAL load. MAIN-world hooks are always installed at `document_start` and just check their setting, which is what lets the other features turn on without a reload.

## Backup file format

```json
{ "app": "kick-tools", "version": "1.1.2", "exportedAt": "…", "settings": { "qualityLock": false, "blockedCategories": ["Minecraft"], "…": "…" } }
```
