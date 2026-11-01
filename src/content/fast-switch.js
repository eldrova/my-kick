// Fast stream switching.
//
// Before a stream starts, Kick's player waits for two ad SDKs to settle, one
// after the other: Datazoom (up to 4 s) and then Google PAL (up to 2 s). Their
// loaders first look for an existing <script src="..."> for the SDK and wait
// for its load/error event. When an ad blocker blocks the SDK, the first tag
// fails once and stays in the page, so on every later channel switch the loader
// finds that dead tag, waits for an event that never comes and runs into both
// timeouts: ~6 s before the new stream even starts loading.
//
// We remove an SDK <script> as soon as it fails. The next attempt then creates
// a fresh tag, which fails right away, and the player goes on without waiting.
// Without an ad blocker the scripts load normally and nothing is removed.
(() => {
  const AD_SDK_SRC = /^https:\/\/(imasdk\.googleapis\.com\/|([a-z0-9-]+\.)?kick\.com\/datazoom\/)/;

  let enabled = KT_DEFAULT_SETTINGS.fastStreamSwitch;

  // Resource errors don't bubble, but a capturing listener on window sees them.
  window.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (!enabled || !(el instanceof HTMLScriptElement) || !AD_SDK_SRC.test(el.src)) return;
      // Let Kick's own error handler on the tag run first.
      setTimeout(() => el.remove(), 0);
    },
    true
  );

  const apply = (s) => {
    enabled = !!s.fastStreamSwitch;
  };
  ktGetSettings().then(apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) ktGetSettings().then(apply);
  });
})();
