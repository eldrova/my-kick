// Runs in the page's MAIN world at document_start. Keeps deleted chat messages
// visible (struck through, with a "(Deleted)" tag) instead of removing them.
//
// How Kick handles it (chat store, zustand):
//  - WebSocket event App\Events\MessageDeletedEvent -> handleDeleteChatMessageEvent
//    tags the message with ui_metadata.deleted = userCanModerate ? "mod_deleted"
//    : "user_deleted". The row renders "mod_deleted" as the original text struck
//    through + " (Deleted)" (+ "AI Mod" and the violated rule), and
//    "user_deleted" as just "Deleted by a moderator".
//  - App\Events\UserBannedEvent -> handleBanUserEvent: moderators see the user's
//    messages struck through with "(Banned)" / "(Timed out)"; everyone else has
//    all of that user's messages removed.
// So Kick already has the display we want, it only shows it to moderators.
// While one of those two handlers runs we make `userCanModerate` read true, and
// only then. The real value is never changed, so no moderator UI appears.
//
// The store copies its state with Object.assign({}, state, partial) on every
// update, which goes through [[Set]]: setters on Object.prototype for these
// keys see each copy and install the wrapped versions on it.
(() => {
  if (window.__kickToolsChatDeleted) return;
  window.__kickToolsChatDeleted = true;

  const MSG_SOURCE = "kick-tools";

  let enabled = false; // until the settings arrive
  let showBanNotices = false;
  let inHandler = false; // a wrapped handler is running with userCanModerate forced
  let inBanHandler = false;
  let realCanModerate = false;

  const define = (obj, key, desc) =>
    Object.defineProperty(obj, key, { configurable: true, enumerable: true, ...desc });

  Object.defineProperty(Object.prototype, "userCanModerate", {
    configurable: true,
    enumerable: false,
    get() {
      return undefined;
    },
    set(v) {
      // Copies made while a wrapped handler runs read the forced value; don't
      // let that leak into the real one.
      if (!inHandler) realCanModerate = !!v;
      define(this, "userCanModerate", {
        get: () => inHandler || realCanModerate,
        set: (next) => {
          if (!inHandler) realCanModerate = !!next;
        },
      });
    },
  });

  // Wraps store method `name` on every state copy (see the header comment).
  const hookMethod = (name, wrap) => {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: false,
      get() {
        return undefined;
      },
      set(fn) {
        let value = fn;
        if (typeof fn === "function" && !fn.__ktWrapped) {
          value = wrap(fn);
          value.__ktWrapped = true;
        }
        define(this, name, { value, writable: true });
      },
    });
  };

  const asModerator = (fn, self, args) => {
    if (!enabled) return fn.apply(self, args);
    inHandler = true;
    try {
      return fn.apply(self, args);
    } finally {
      inHandler = false;
    }
  };

  hookMethod("handleDeleteChatMessageEvent", (fn) =>
    function (...args) {
      return asModerator(fn, this, args);
    }
  );

  hookMethod("handleBanUserEvent", (fn) =>
    function (...args) {
      inBanHandler = true;
      try {
        return asModerator(fn, this, args);
      } finally {
        inBanHandler = false;
      }
    }
  );

  // In moderator mode the ban handler also adds a "<mod> timed out <user> for
  // 30 minutes" line via addEntry(). Viewers never got that line, so drop it
  // unless "Show ban notices" is on. Real moderators keep it.
  hookMethod("addEntry", (fn) =>
    function (...args) {
      if (inBanHandler && inHandler && !realCanModerate && !showBanNotices) return;
      return fn.apply(this, args);
    }
  );

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-page" || d.type !== "settings") return;
    enabled = !!d.settings?.keepDeletedMessages;
    showBanNotices = !!d.settings?.showBanNotices;
  });
})();
