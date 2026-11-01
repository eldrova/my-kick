// Runs in the page's MAIN world at document_start, before Kick's bundles load.
//
// How Kick picks stream quality (Amazon IVS player):
//  - On player READY it reads sessionStorage "stream_quality" (a height). If a
//    rendition with that exact height exists it calls player.setQuality(),
//    otherwise player.setAutoQualityMode(true).
//  - On every new stream it clears that key whenever the saved value is >= 1080.
//  - In auto mode the ceiling is 720p on desktop (1080p only on "TV" mode).
// So we catch the IVS player's own methods: while the lock is on, any request
// to go back to auto is replaced with "pick the highest rendition".
(() => {
  if (window.__kickToolsQualityLock) return;
  window.__kickToolsQualityLock = true;

  const TAG = "[My'Kick]";
  const MSG_SOURCE = "kick-tools";

  // Off until the settings arrive (a few ms after load, long before the player
  // is READY). If the lock is on, applyAll() locks any player seen meanwhile.
  let enabled = false;
  // IVS MediaPlayer instances (outer wrapper preferred), held weakly so players
  // Kick has thrown away (tile previews, clips, old channels) can be collected.
  const playerRefs = new Set();
  const livePlayers = () => {
    const out = [];
    for (const ref of playerRefs) {
      const p = ref.deref();
      if (p) out.push(p);
      else playerRefs.delete(ref);
    }
    return out;
  };
  // prototype -> Map(methodName -> fn). A Map, not a plain object: assigning
  // one of the hooked names on a plain object would re-enter our own setter.
  const originals = new WeakMap();

  const pickBest = (qualities) => {
    if (!Array.isArray(qualities) || !qualities.length) return null;
    return [...qualities].sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) ||
        (b.framerate || 0) - (a.framerate || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0)
    )[0];
  };

  const callOriginal = (player, name, args) => {
    let proto = Object.getPrototypeOf(player);
    while (proto) {
      const fn = originals.get(proto)?.get(name);
      if (fn) return fn.apply(player, args);
      proto = Object.getPrototypeOf(proto);
    }
    return player[name]?.apply(player, args);
  };

  // The IVS wrapper delegates to an inner "core" object that has the same
  // method names. Keep only the outermost object so we act on each player once.
  const track = (player) => {
    if (!player) return;
    const players = livePlayers();
    if (players.includes(player)) return;
    const looksLikePlayer = ["getQuality", "setQuality", "isAutoQualityMode"].every(
      (m) => typeof player[m] === "function"
    );
    if (!looksLikePlayer) return;
    const isWrapper = typeof player.checkCore === "function";
    if (!isWrapper) {
      if (players.some((p) => typeof p.checkCore === "function")) return;
    } else {
      for (const ref of playerRefs) if (typeof ref.deref()?.checkCore !== "function") playerRefs.delete(ref);
    }
    playerRefs.add(new WeakRef(player));
  };

  const lockToBest = (player) => {
    try {
      const best = pickBest(callOriginal(player, "getQualities", []));
      if (!best) return false;
      const current = callOriginal(player, "getQuality", []);
      const isAuto = callOriginal(player, "isAutoQualityMode", []);
      if (!isAuto && current && current.name === best.name) return true;
      callOriginal(player, "setQuality", [best, false]);
      console.debug(TAG, "quality locked to", best.name);
      report();
      return true;
    } catch (e) {
      console.warn(TAG, "could not set quality", e);
      return false;
    }
  };

  const wrappers = {
    setAutoQualityMode(orig) {
      return function (on) {
        track(this);
        if (enabled && on && lockToBest(this)) return;
        const r = orig.apply(this, arguments);
        report();
        return r;
      };
    },
    getQualities(orig) {
      return function () {
        track(this);
        return orig.apply(this, arguments);
      };
    },
  };

  // Kick's bundle assigns these as plain properties on the player prototypes
  // (`proto.setAutoQualityMode = function () {...}`), so a setter on
  // Object.prototype sees each assignment and can store a wrapped version.
  for (const name of Object.keys(wrappers)) {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: false,
      get() {
        return undefined;
      },
      set(fn) {
        let value = fn;
        if (typeof fn === "function") {
          if (!originals.has(this)) originals.set(this, new Map());
          originals.get(this).set(name, fn);
          value = wrappers[name](fn);
        }
        Object.defineProperty(this, name, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
  }

  const applyAll = () => {
    for (const p of livePlayers()) {
      if (enabled) lockToBest(p);
      else callOriginal(p, "setAutoQualityMode", [true]);
    }
    report();
  };

  const status = () => {
    const p = livePlayers().at(-1); // the most recent one is the one playing
    if (!p) return { enabled, active: false };
    try {
      const q = callOriginal(p, "getQuality", []);
      const best = pickBest(callOriginal(p, "getQualities", []));
      return {
        enabled,
        active: true,
        auto: !!callOriginal(p, "isAutoQualityMode", []),
        current: q ? q.name : null,
        best: best ? best.name : null,
      };
    } catch {
      return { enabled, active: false };
    }
  };

  function report() {
    window.postMessage({ source: MSG_SOURCE, dir: "to-bridge", type: "status", status: status() }, "*");
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-page") return;
    if (d.type === "settings") {
      const next = !!d.settings?.qualityLock;
      if (next !== enabled) {
        enabled = next;
        applyAll();
      }
    } else if (d.type === "get-status") {
      report();
    }
  });

  // Backstop: IVS keeps manual mode on its own, but re-check periodically in case
  // something else flips the player back to auto.
  setInterval(() => {
    if (!enabled) return;
    for (const p of livePlayers()) {
      try {
        if (callOriginal(p, "isAutoQualityMode", [])) lockToBest(p);
      } catch {}
    }
  }, 5000);
})();
