import { getSettings } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'enabled', 'hideMode', 'hidePromoted', 'showBadges',
  'useNano', 'useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel',
  'groqKey', 'groqModel', 'ambiguousPolicy',
];
const NANO_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

async function initSettings() {
  const settings = await getSettings();
  for (const key of FIELDS) {
    const el = $(key);
    const prop = el.type === 'checkbox' ? 'checked' : 'value';
    el[prop] = settings[key];
    el.addEventListener('change', () => {
      const value = prop === 'value' ? el.value.trim() : el.checked;
      chrome.storage.local.set({ [key]: value });
    });
  }
}

async function showStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'stats' });
    if (!s.onFeed) return;
    const sources = Object.entries(s.bySource).map(([k, v]) => `${k}: ${v}`).join(', ');
    $('stats').textContent =
      `Kept ${s.kept} · Hidden ${s.hidden}` + (s.pending ? ` · Checking ${s.pending}` : '') +
      (sources ? `\nDecided by ${sources}` : '');
    $('stats').style.whiteSpace = 'pre-line';
  } catch {
    // Not a LinkedIn tab; keep the default message.
  }
}

async function showNanoStatus() {
  const status = $('nanoStatus');
  if (typeof LanguageModel === 'undefined') {
    status.textContent = 'Not supported in this Chrome (needs Chrome 138+ on a supported device).';
    return;
  }
  const availability = await LanguageModel.availability(NANO_OPTIONS);
  const bg = await chrome.runtime.sendMessage({ type: 'nanoStatus', force: true });
  const messages = {
    available: `Ready${bg?.arabic ? ' (English + Arabic)' : ' (English only; Arabic posts prefer Groq)'}.`,
    downloadable: 'Model not downloaded yet (several GB).',
    downloading: 'Downloading…',
    unavailable: "Your device doesn't meet the hardware requirements. Use Groq instead.",
  };
  status.textContent = messages[availability] ?? availability;
  $('nanoDownload').hidden = availability !== 'downloadable';
}

$('nanoDownload').addEventListener('click', async () => {
  // The click provides the user activation Chrome requires to start the download.
  $('nanoDownload').disabled = true;
  try {
    const session = await LanguageModel.create({
      ...NANO_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          $('nanoStatus').textContent = `Downloading… ${Math.round(e.loaded * 100)}% (you can close this popup)`;
        });
      },
    });
    session.destroy();
  } catch (err) {
    $('nanoStatus').textContent = `Download failed: ${err.message}`;
    $('nanoDownload').disabled = false;
    return;
  }
  await showNanoStatus();
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  $('clearCache').textContent = 'Cleared';
});

initSettings();
showStats();
showNanoStatus();
