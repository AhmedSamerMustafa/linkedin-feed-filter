// Receives ambiguous posts from the content script and runs them through the
// LLM chain: Gemini Nano (local, free) → Cloudflare Clef (free tier) → Groq
// (free tier) → give up.
import { getSettings } from './shared/settings.js';
import { KEEP_CATEGORIES, SYSTEM_PROMPT, parseCategory, prepareText } from './shared/prompt.js';
import { classifyClef } from './shared/clef.js';
import { clefBackoffUntil, providerOrder } from './shared/routing.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const NANO_RECHECK_MS = 5 * 60 * 1000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Free tier allows 8000 tokens/minute; at ~600 tokens per post that's ~13 posts/minute.
const GROQ_MIN_GAP_MS = 5000;
const CACHE_KEY = 'llmCache';
const CACHE_MAX = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Offscreen document (Gemini Nano) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: 'Runs Chrome built-in AI (Prompt API) to classify feed posts on-device.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (res?.error) throw new Error(res.error);
  return res;
}

let nanoStatus = null; // { availability, arabic, at }
let clefBlockedUntil = 0; // Infinity when credentials are rejected; a timestamp when quota is exhausted

async function getNanoStatus(force = false) {
  const fresh = nanoStatus && Date.now() - nanoStatus.at < NANO_RECHECK_MS;
  if (!force && (nanoStatus?.availability === 'available' || fresh)) return nanoStatus;
  try {
    nanoStatus = { ...(await toOffscreen({ type: 'status' })), at: Date.now() };
  } catch (err) {
    nanoStatus = { availability: 'error', arabic: false, error: String(err), at: Date.now() };
  }
  return nanoStatus;
}

async function nanoClassify(text) {
  try {
    return (await toOffscreen({ type: 'classify', text })).category;
  } catch (err) {
    // Back off from Nano for a while; the next status check decides if it's usable again.
    nanoStatus = { availability: 'error', arabic: false, error: String(err), at: Date.now() };
    throw err;
  }
}

// ---------- Groq ----------

let nextGroqAt = 0;

async function groqClassify(text, { groqKey, groqModel }, retried = false) {
  const wait = nextGroqAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextGroqAt = Date.now() + GROQ_MIN_GAP_MS;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: groqModel,
      temperature: 0,
      // Reasoning models (gpt-oss) spend tokens thinking before the JSON; with a small
      // limit they're cut off and Groq rejects the response. Unused tokens aren't billed.
      max_tokens: 300,
      ...(groqModel.startsWith('openai/gpt-oss') && { reasoning_effort: 'low' }),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) {
    nextGroqAt = Date.now() + (Number(res.headers.get('retry-after')) || 10) * 1000;
    if (!retried) return groqClassify(text, { groqKey, groqModel }, true);
    throw new Error('Groq rate limited');
  }
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseCategory(data.choices?.[0]?.message?.content ?? '');
}

// ---------- Cache (only LLM results; keyword results are free to recompute) ----------

let cache = null;
let cacheSaveTimer = null;

async function loadCache() {
  cache ??= new Map(Object.entries((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] ?? {}));
  return cache;
}

function saveCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  }, 2000);
}

// ---------- Classification ----------

// One LLM call at a time; Nano is single-session and Groq is rate limited.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function runLLMChain(text, arabic) {
  const settings = await getSettings();
  const nano = settings.useNano ? await getNanoStatus() : null;
  const hasClef =
    settings.useClef &&
    Boolean(settings.cloudflareAccountId) &&
    Boolean(settings.cloudflareApiKey) &&
    Date.now() >= clefBlockedUntil;
  const hasGroq = Boolean(settings.groqKey);

  // Nano first. Exception: Arabic posts go to Clef/Groq first when Nano lacks Arabic support.
  const order = providerOrder({ nanoStatus: nano, arabic, hasClef, hasGroq });

  for (const source of order) {
    try {
      if (source === 'clef') {
        return { ...(await classifyClef(text, settings)), source };
      }
      const category = source === 'nano' ? await nanoClassify(text) : await groqClassify(text, settings);
      if (category) return { category, source, confidence: null };
    } catch (err) {
      if (source === 'clef') clefBlockedUntil = Math.max(clefBlockedUntil, clefBackoffUntil(err));
      console.warn(`[LIF] ${source} failed`, err);
    }
  }
  return { category: null, source: 'none', confidence: null };
}

async function classify({ key, text, arabic }) {
  const c = await loadCache();
  if (c.has(key)) return { ...c.get(key), cached: true };

  const { category, source, confidence = null } = await enqueue(() => runLLMChain(prepareText(text), arabic));
  const result = { category, keep: category ? KEEP_CATEGORIES.has(category) : null, source, confidence };
  if (category) {
    c.set(key, result);
    saveCacheSoon();
  }
  return result;
}

const handlers = {
  getSettings: () => getSettings(),
  classify,
  nanoStatus: (msg) => getNanoStatus(msg.force),
  clearCache: async () => {
    cache = new Map();
    await chrome.storage.local.remove(CACHE_KEY);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen' || !handlers[msg?.type]) return false;
  handlers[msg.type](msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});
