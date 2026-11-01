const message = document.getElementById("message");
const importFile = document.getElementById("importFile");

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

// Settings that only take effect from page load (see data-reload-on-enable in
// the popup): if an import turns one of them on, offer to reload Kick tabs.
const RELOAD_ON_ENABLE = ["fastStreamSwitch"];

const showMessage = (text, kind = "", action = null) => {
  message.replaceChildren(document.createTextNode(text));
  message.className = "message" + (kind ? " " + kind : "");
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    message.append(btn);
  }
  message.hidden = false;
};

const renderStats = async () => {
  const s = await ktGetSettings();
  const toggles = Object.entries(KT_DEFAULT_SETTINGS).filter(([, def]) => typeof def === "boolean");
  document.getElementById("statOn").textContent = `${toggles.filter(([k]) => s[k]).length} / ${toggles.length}`;
  document.getElementById("statCategories").textContent = s.blockedCategories.length;
  document.getElementById("statStreamers").textContent = s.blockedStreamers.length;
  document.getElementById("statTitleWords").textContent = s.blockedTitleWords.length;
};

const reloadKickTabs = async () => {
  const tabs = await chrome.tabs.query({ url: ["https://kick.com/*", "https://*.kick.com/*"] });
  for (const tab of tabs) chrome.tabs.reload(tab.id);
  showMessage(tabs.length ? `Reloaded ${tabs.length} Kick tab(s).` : "No Kick tabs are open.");
};

document.getElementById("exportBtn").addEventListener("click", async () => {
  try {
    await ktDownloadBackup();
    showMessage("Settings exported. Keep the file somewhere safe.");
  } catch (e) {
    showMessage(`Export failed: ${e.message}`, "error");
  }
});

document.getElementById("importBtn").addEventListener("click", () => importFile.click());

importFile.addEventListener("change", async () => {
  const file = importFile.files[0];
  importFile.value = "";
  if (!file) return;
  try {
    const { before, settings } = await ktImportBackup(await file.text());
    await renderStats();
    const needsReload = RELOAD_ON_ENABLE.some((k) => settings[k] && !before[k]);
    const summary =
      `Imported ${settings.blockedCategories.length} blocked categories, ` +
      `${settings.blockedStreamers.length} blocked streamers and ` +
      `${settings.blockedTitleWords.length} blocked title words.`;
    if (needsReload) {
      showMessage(`${summary} Reload Kick to apply Turbo switching.`, "warn", {
        label: "Reload Kick tabs",
        onClick: reloadKickTabs,
      });
    } else {
      showMessage(`${summary} Everything is applied.`);
    }
  } catch (e) {
    showMessage(e.message, "error");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) renderStats();
});

renderStats();
