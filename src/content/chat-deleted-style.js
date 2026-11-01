// Look of kept deleted messages (see src/inject/chat-deleted.js): instead of
// Kick's moderator style (text struck through + " (Deleted)"), the row gets a
// faint red background and the name/message are dimmed. "AI Mod", the violated
// rule and "(Banned)" / "(Timed out)" stay as they are.
//
// A deleted row renders as
//   <span class="text-neutral leading-[1.55]">
//     <span class="line-through">message</span>
//     <span class="font-semibold"> (Deleted) [AI Mod] [rule]</span>
//   </span>
// next to the badges/username and ": ". Everything is plain CSS (:has), which
// keeps working while the virtualized chat recycles rows. Only the "(Deleted)"
// label needs a script, because CSS can't tell it from "(Banned)" by its text.
(() => {
  if (window.top !== window) return;

  const ROOT_CLASS = "kt-keep-deleted";
  const LABEL_CLASS = "kt-deleted-label";
  const MSG = "span.leading-\\[1\\.55\\]";
  const STRUCK = `${MSG} > .line-through`;

  const style = document.createElement("style");
  style.textContent = `
    html.${ROOT_CLASS} [data-index]:has(${STRUCK}) > .group {
      background: rgba(229, 72, 77, 0.12);
      border-radius: 6px;
    }
    html.${ROOT_CLASS} ${MSG}:has(> .line-through) { color: inherit; }
    html.${ROOT_CLASS} ${STRUCK} { text-decoration: none; opacity: 0.45; }
    /* badges, username and ": " next to the message */
    html.${ROOT_CLASS} :has(> ${STRUCK}) > :not(${MSG}) { opacity: 0.45; }
    /* hide the " (Deleted)" text but keep the AI Mod / rule badges inside it */
    html.${ROOT_CLASS} .${LABEL_CLASS} { font-size: 0 !important; }
    html.${ROOT_CLASS} .${LABEL_CLASS} > * {
      font-size: calc(var(--chatroom-font-size) - 2px);
      margin-left: 4px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const isDeletedLabel = (el) => {
    const t = el.firstChild;
    return t?.nodeType === Node.TEXT_NODE && t.nodeValue.replace(/\u00a0/g, " ").trim() === "(Deleted)";
  };

  let enabled = false;
  let scheduled = false;

  const update = () => {
    scheduled = false;
    document.documentElement.classList.toggle(ROOT_CLASS, enabled);
    // Rows get reused for other messages, so re-check labels marked earlier.
    for (const el of document.querySelectorAll(`.${LABEL_CLASS}`)) {
      if (!enabled || !isDeletedLabel(el)) el.classList.remove(LABEL_CLASS);
    }
    if (!enabled) return;
    for (const struck of document.querySelectorAll(STRUCK)) {
      for (const el of struck.parentElement.children) {
        if (el !== struck && isDeletedLabel(el)) el.classList.add(LABEL_CLASS);
      }
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };

  new MutationObserver(() => enabled && schedule()).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  const apply = (s) => {
    enabled = !!s.keepDeletedMessages;
    schedule();
  };
  ktGetSettings().then(apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) ktGetSettings().then(apply);
  });
})();
