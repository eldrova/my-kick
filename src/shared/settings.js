// Shared by the content scripts, the popup and the options page. Add new
// feature flags here. These are also the defaults of a fresh install.
const KT_DEFAULT_SETTINGS = {
  qualityLock: false,
  fastStreamSwitch: false,
  expandFollowing: false,
  hideOfflineFollowing: false, // only applies while expandFollowing is on
  autoAcceptChatRules: false,
  keepDeletedMessages: false,
  showBanNotices: false, // "<mod> timed out <user> for 30 minutes" lines, only with keepDeletedMessages
  blockCategories: true,
  blockedCategories: [], // names as the user typed them
  showBlockButtons: true, // × on each category card, only while blockCategories is on
  keepFollowedInBlockedCategories: true, // followed streamers stay visible in blocked categories
  blockStreamers: true,
  blockedStreamers: [], // names as the user typed them
  showStreamerBlockButtons: true, // × on each stream card, only while blockStreamers is on
  blockTitles: true,
  blockedTitleWords: [], // words/phrases as the user typed them, matched anywhere in a stream title
};

// Block-list matching key: "Just Chatting", "just chatting" and the slug
// "just-chatting" all become "justchatting", so matching ignores case, spaces
// and punctuation. Same for streamer names vs. channel slugs.
const ktNormalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "");

// Title-word matching key. Unlike ktNormalize it keeps spaces, punctuation and
// letters outside a-z (so Turkish words survive), and only folds case and
// accents: "KUMAR", "Kumar" and "kumar" match, and so do "ÇIKIŞ" / "cikis"
// (İ/I/ı all become i).
const ktFoldTitle = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();

// Duplicate/empty check for a block list, by settings key.
const ktListNormalizer = (key) => (key === "blockedTitleWords" ? ktFoldTitle : ktNormalize);

const ktGetSettings = async () => {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...KT_DEFAULT_SETTINGS, ...settings };
};

const ktSetSetting = async (key, value) => {
  const settings = await ktGetSettings();
  settings[key] = value;
  await chrome.storage.local.set({ settings });
  return settings;
};

// --- Backup (export / import) ----------------------------------------------

// Internal id written into backup files. Kept from the old "Kick Tools" name
// so earlier backups still import.
const KT_BACKUP_APP = "kick-tools";
const KT_MAX_LIST_ITEMS = 5000;

// Keeps only known keys with the right type. Lists are trimmed, deduplicated
// (case/spacing-insensitive, like the popup) and capped.
const ktSanitizeSettings = (raw) => {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, def] of Object.entries(KT_DEFAULT_SETTINGS)) {
    const value = raw[key];
    if (typeof def === "boolean" && typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(def) && Array.isArray(value)) {
      const normalize = ktListNormalizer(key);
      const seen = new Set();
      out[key] = value
        .filter((v) => typeof v === "string")
        .map((v) => v.trim().replace(/\s+/g, " ").slice(0, 80))
        .filter((v) => {
          const norm = normalize(v);
          if (!norm || seen.has(norm)) return false;
          seen.add(norm);
          return true;
        })
        .slice(0, KT_MAX_LIST_ITEMS);
    }
  }
  return out;
};

const ktBuildBackup = async () => ({
  app: KT_BACKUP_APP,
  version: chrome.runtime.getManifest().version,
  exportedAt: new Date().toISOString(),
  settings: await ktGetSettings(),
});

const ktDownloadBackup = async () => {
  const backup = await ktBuildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mykick-settings-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Replaces all settings with the ones in `text` (a backup file's contents).
// Throws with a readable message when the file isn't a My'Kick backup.
const ktImportBackup = async (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  if (!data || data.app !== KT_BACKUP_APP || typeof data.settings !== "object") {
    throw new Error("This isn't a My'Kick backup file.");
  }
  const before = await ktGetSettings();
  const settings = { ...KT_DEFAULT_SETTINGS, ...ktSanitizeSettings(data.settings) };
  await chrome.storage.local.set({ settings });
  return { before, settings };
};
