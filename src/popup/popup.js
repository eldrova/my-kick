const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const inputs = [...document.querySelectorAll("[data-setting]")];

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

const esc = (s) => String(s ?? "?").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const setStatus = (html, state = "") => {
  statusText.innerHTML = html;
  statusDot.className = "dot" + (state ? " " + state : "");
};

const getKickTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/([a-z0-9-]+\.)?kick\.com\//.test(tab.url || "") ? tab : null;
};

const refreshStatus = async () => {
  const tab = await getKickTab();
  if (!tab) return setStatus("No Kick tab open");

  let status;
  try {
    ({ status } = await chrome.tabs.sendMessage(tab.id, { type: "get-status" }));
  } catch {
    return setStatus("Reload the page to activate", "warn");
  }

  if (!status?.active) return setStatus("No stream playing");
  if (!status.enabled) return setStatus(`Auto · now <b>${esc(status.current)}</b>`);
  if (status.auto) return setStatus("Locking…", "warn");
  setStatus(`Locked · <b>${esc(status.current)}</b>`, "on");
};

// Options with data-requires are greyed out while their parent toggle is off.
const syncDependencies = () => {
  for (const input of inputs) {
    const parentKey = input.dataset.requires;
    if (!parentKey) continue;
    const parent = inputs.find((i) => i.dataset.setting === parentKey);
    const off = !parent?.checked;
    input.disabled = off;
    input.closest(".feature").classList.toggle("disabled", off);
  }
};

// Block-list editors: <div class="block-editor" data-list="<settings key>">.
const setupBlockEditor = (editor, initial) => {
  const key = editor.dataset.list;
  const form = editor.querySelector(".block-add");
  const input = form.querySelector("input");
  const chips = editor.querySelector(".chips");
  const empty = editor.querySelector(".empty");
  const normalize = ktListNormalizer(key);
  let list = initial || [];

  const render = () => {
    chips.replaceChildren(
      ...list.map((name) => {
        const li = document.createElement("li");
        li.className = "chip";
        const label = document.createElement("span");
        label.className = "chip-name";
        label.textContent = name;
        label.title = name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chip-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Unblock ${name}`);
        remove.addEventListener("click", () => save(list.filter((n) => n !== name)));
        li.append(label, remove);
        return li;
      })
    );
    empty.hidden = list.length > 0;
  };

  const save = async (next) => {
    list = next;
    render();
    await ktSetSetting(key, next);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim().replace(/\s+/g, " ");
    const norm = normalize(name);
    if (!norm) return;
    // Case/spacing-insensitive duplicate check: "minecraft" == "Minecraft".
    if (list.some((n) => normalize(n) === norm)) {
      form.classList.add("dupe");
      setTimeout(() => form.classList.remove("dupe"), 800);
      return;
    }
    input.value = "";
    save([...list, name]);
  });

  render();
};

// Copy link for VLC: the tab's content script (src/content/vlc-link.js)
// resolves the stream, the popup copies it and shows it for manual copying.
const vlcBtn = document.getElementById("vlcBtn");
const vlcDesc = document.getElementById("vlcDesc");
const vlcUrl = document.getElementById("vlcUrl");

const setVlcDesc = (text, state = "") => {
  vlcDesc.textContent = text;
  vlcDesc.className = "feature-desc" + (state ? " " + state : "");
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    vlcUrl.select();
    return document.execCommand("copy");
  }
};

vlcBtn.addEventListener("click", async () => {
  const tab = await getKickTab();
  if (!tab) return setVlcDesc("Open Kick in this tab first", "warn");

  vlcBtn.disabled = true;
  vlcBtn.textContent = "…";
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "get-vlc-link" });
  } catch {
    res = { error: "Reload the page to activate" };
  }
  vlcBtn.disabled = false;
  vlcBtn.textContent = "Copy";

  if (!res?.link) {
    vlcUrl.hidden = true;
    return setVlcDesc(res?.error || "Couldn't get the link", "warn");
  }
  const { kind, channel, url, temporary } = res.link;
  vlcUrl.value = url;
  vlcUrl.hidden = false;
  const copied = await copyText(url);
  const what = [kind, channel].filter(Boolean).join(" · ");
  if (!copied) return setVlcDesc(`${what} · copy it below`, "warn");
  // Temporary links carry a token that expires (live ~10 min, VOD 1 h).
  setVlcDesc(temporary ? `Copied ${what} · open it soon` : `Copied ${what} · Ctrl+N in VLC`, "ok");
});

vlcUrl.addEventListener("focus", () => vlcUrl.select());

// Backup: export downloads right here. Chrome closes the popup when a file
// picker opens, so importing happens on the options page instead.
document.getElementById("exportBtn").addEventListener("click", () => ktDownloadBackup());
document.getElementById("importBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

const init = async () => {
  const settings = await ktGetSettings();
  for (const input of inputs) {
    const key = input.dataset.setting;
    input.checked = !!settings[key];
    input.addEventListener("change", async () => {
      // A setting can have a toggle in more than one group; keep them in step.
      for (const other of inputs) if (other.dataset.setting === key) other.checked = input.checked;
      syncDependencies();
      await ktSetSetting(key, input.checked);
      if (key === "qualityLock") setTimeout(refreshStatus, 400);
      // Features that can only take effect from page load (data-reload-on-enable)
      // reload the active Kick tab when switched on.
      if (input.checked && "reloadOnEnable" in input.dataset) {
        const tab = await getKickTab();
        if (tab) chrome.tabs.reload(tab.id);
      }
    });
  }
  for (const editor of document.querySelectorAll(".block-editor")) {
    setupBlockEditor(editor, settings[editor.dataset.list]);
  }
  syncDependencies();
  refreshStatus();
};

init();
