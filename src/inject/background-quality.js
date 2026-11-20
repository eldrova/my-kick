// Keep stream quality in background tabs.
//
// Runs in the page's MAIN world at document_start, before Kick's bundles load.
//
// Kick creates its Amazon IVS player with
//   optimizeBackgroundPlayback: { enabled: true, switchDelayMs: 60000 }
// (the SDK default is enabled: false). When the tab is hidden the player posts
//   { id, funcName: "setVisible", args: [false] }
// to its worker, and the worker drops the stream to a low rendition 60 s later,
// until the tab is visible again (setVisible(true)).
//
// While the setting is on we forward setVisible(true) instead of false, so the
// worker never learns the page went to the background and keeps the quality.
// Switching the setting re-sends the right state to every player worker right
// away, so it works without reloading the page.
(() => {
  if (window.__kickToolsBgQuality) return;
  window.__kickToolsBgQuality = true;

  const MSG_SOURCE = "kick-tools";
  const origPost = Worker.prototype.postMessage;

  let enabled = false; // off until the settings arrive from the bridge
  // worker -> Map(target id -> visibility we last actually sent to it)
  const sent = new WeakMap();
  const workers = new Set(); // WeakRefs of workers seen, for resync()

  const isSetVisible = (m) =>
    !!m &&
    typeof m === "object" &&
    m.funcName === "setVisible" &&
    Array.isArray(m.args) &&
    typeof m.args[0] === "boolean";

  const remember = (worker, id, visible) => {
    let ids = sent.get(worker);
    if (!ids) {
      ids = new Map();
      sent.set(worker, ids);
      // Drop refs to workers that are gone, so the set stays as small as the
      // number of live players instead of growing with every channel switch.
      for (const ref of workers) if (!ref.deref()) workers.delete(ref);
      workers.add(new WeakRef(worker));
    }
    ids.set(id, visible);
  };

  Worker.prototype.postMessage = function (msg, ...rest) {
    if (isSetVisible(msg)) {
      const visible = enabled ? true : msg.args[0];
      if (visible !== msg.args[0]) msg = { ...msg, args: [visible] };
      remember(this, msg.id, visible);
    }
    return origPost.call(this, msg, ...rest);
  };

  // Tell every known player worker the visibility it should see now: always
  // "visible" while enabled, the real state otherwise.
  const resync = () => {
    const visible = enabled || document.visibilityState === "visible";
    for (const ref of workers) {
      const worker = ref.deref();
      if (!worker) {
        workers.delete(ref);
        continue;
      }
      const ids = sent.get(worker);
      if (!ids) continue;
      for (const [id, last] of ids) {
        if (last === visible) continue;
        try {
          origPost.call(worker, { id, funcName: "setVisible", args: [visible] });
          ids.set(id, visible);
        } catch {}
      }
    }
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== MSG_SOURCE || d.dir !== "to-page") return;
    if (d.type !== "settings") return;
    const next = !!d.settings?.keepQualityInBackground;
    if (next === enabled) return;
    enabled = next;
    resync();
  });
})();
