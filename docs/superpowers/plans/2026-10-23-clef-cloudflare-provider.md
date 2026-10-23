# Cloudflare Clef Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cloudflare Workers AI as the preferred cloud classifier, supporting `clef-flash`, `clef`, and `clef-omni`, with Groq as the secondary fallback.

**Architecture:** A new `src/shared/clef.js` module owns the System One request/response contract. A new `src/shared/routing.js` owns provider order and quota backoff as pure functions. `background.js` adds `clef` to the existing LLM chain; settings, popup, manifest, and content badges are extended. No build step, no new runtime dependencies.

**Tech Stack:** Chrome Manifest V3, vanilla ES modules for the service worker/offscreen/popup, classic scripts for content scripts, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-23-clef-cloudflare-provider-design.md`

## Global Constraints

- Manifest V3, Chrome 138+, no build step, no new runtime dependencies.
- Cloudflare is the **primary cloud provider**; Groq remains secondary.
- Gemini Nano stays first when available. Keywords still run before any LLM.
- Supported model strings are exactly `clef-flash`, `clef`, `clef-omni`; default `clef-flash`.
- Cloudflare endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}`.
- BYO account ID and API token. Never ship a shared key.
- 15-second request timeout.
- `401`/`403` disables Clef for the session. `429`/quota disables Clef until the next UTC midnight.
- Do not gate on confidence in v1; record it and show it in badges.
- Existing behavior must be unchanged when Cloudflare is not configured.

**Pre-flight working tree note:** this repo already has unrelated uncommitted changes: `.gitignore`, `bun.lock`, `node_modules/`, `test-clef.js`, an `openai` dependency in `package.json`, and a trailing-newline change in `src/content/keywords.js`. Do not revert or stage them. Stage only the feature files listed in each task. If `package.json` cannot be staged without the pre-existing `openai` hunk, leave it unstaged and tell the user.

## Review Focus

- **Cloudflare failure or quota exhaustion:** a post must never be stuck in `pending`; the chain falls through to Groq and then the keyword lean. Covered by `tests/routing.test.js` and the background guard.
- **Malformed or unknown category:** the parser must return `null` rather than writing an invalid category into the DOM. Covered by `tests/clef.test.js`.
- **Missing or invalid credentials:** Clef must be silently skipped; existing Nano/Groq behavior must be identical. Covered by `tests/routing.test.js` and `tests/config.test.js`.
- **Arabic routing:** when Nano lacks Arabic, Clef must come before Groq and before Nano. Covered by `tests/routing.test.js`.
- **Confidence rendering:** old cache entries without confidence and `0` confidence must render without `NaN%`. Covered by `tests/format.test.js`.

---

### Task 1: Clef protocol module and tests

**Files:**
- Create: `src/shared/clef.js`
- Create: `tests/clef.test.js`
- Modify: `package.json` (test script only)

**Interfaces:**
- Consumes: `CATEGORIES` from `src/shared/prompt.js`.
- Produces:
  - `CLEF_MODELS: string[]`
  - `DEFAULT_CLEF_MODEL: 'clef-flash'`
  - `resolveClefModel(model?: string): string`
  - `buildClefRequest(text: string, model?: string): object`
  - `parseClefResponse(data: object): { category: string, confidence: number|null, probabilities: object|null } | null`
  - `classifyClef(text: string, settings: { cloudflareAccountId: string, cloudflareApiKey: string, clefModel?: string }): Promise<{ category: string, confidence: number|null, probabilities: object|null }>`

- [ ] **Step 1: Write the failing tests**

Create `tests/clef.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/shared/clef.js');

test('buildClefRequest creates a 7-option choice question', async () => {
  const { buildClefRequest } = await load();
  const req = buildClefRequest('We are hiring', 'clef');
  assert.equal(req.model, 'clef');
  assert.equal(req.state, 'We are hiring');
  assert.equal(req.questions.category.type, 'choice');
  assert.match(req.questions.category.instructions, /LinkedIn post/);
  assert.deepEqual(
    Object.keys(req.questions.category.criteria).sort(),
    ['advice', 'complaint', 'event', 'offer', 'opportunity', 'other', 'story'],
  );
});

test('resolveClefModel accepts known models and defaults unknown ones', async () => {
  const { resolveClefModel } = await load();
  assert.equal(resolveClefModel('clef-omni'), 'clef-omni');
  assert.equal(resolveClefModel('clef'), 'clef');
  assert.equal(resolveClefModel('bogus'), 'clef-flash');
  assert.equal(resolveClefModel(undefined), 'clef-flash');
});

test('parseClefResponse returns the selected category and confidence', async () => {
  const { parseClefResponse } = await load();
  const data = {
    success: true,
    result: {
      answers: {
        category: {
          type: 'choice',
          choice: 'opportunity',
          confidence: 0.91,
          probabilities: { opportunity: 0.91, other: 0.09 },
        },
      },
    },
  };
  assert.deepEqual(parseClefResponse(data), {
    category: 'opportunity',
    confidence: 0.91,
    probabilities: { opportunity: 0.91, other: 0.09 },
  });
});

test('parseClefResponse rejects failed envelopes and unknown categories', async () => {
  const { parseClefResponse } = await load();
  assert.equal(parseClefResponse({ success: false, errors: [] }), null);
  assert.equal(parseClefResponse({ success: true, result: { answers: {} } }), null);
  assert.equal(
    parseClefResponse({
      success: true,
      result: { answers: { category: { choice: 'vacation' } } },
    }),
    null,
  );
});

test('classifyClef posts to the selected model and returns the parsed answer', async (t) => {
  const { classifyClef } = await load();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          answers: {
            category: { choice: 'event', confidence: 0.8, probabilities: { event: 0.8 } },
          },
        },
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await classifyClef('Join our webinar', {
    cloudflareAccountId: 'acc 1',
    cloudflareApiKey: 'tok',
    clefModel: 'clef-omni',
  });

  assert.deepEqual(result, {
    category: 'event',
    confidence: 0.8,
    probabilities: { event: 0.8 },
  });
  assert.match(calls[0].url, /accounts\/acc%201\/ai\/run\/@cf\/cloudflare\/clef-omni$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  assert.equal(JSON.parse(calls[0].options.body).model, 'clef-omni');
});

test('classifyClef tags quota and auth errors', async (t) => {
  const { classifyClef } = await load();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const respond = (status, message) => {
    globalThis.fetch = async () => ({
      ok: false,
      status,
      json: async () => ({ success: false, errors: [{ message }] }),
    });
  };

  respond(429, 'Daily neuron limit reached');
  await assert.rejects(
    () => classifyClef('x', { cloudflareAccountId: 'a', cloudflareApiKey: 'k' }),
    (err) => err.status === 429 && err.quota === true,
  );

  respond(403, 'Authentication error');
  await assert.rejects(
    () => classifyClef('x', { cloudflareAccountId: 'a', cloudflareApiKey: 'k' }),
    (err) => err.status === 403 && err.quota === false,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/clef.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shared/clef.js`.

- [ ] **Step 3: Implement `src/shared/clef.js`**

Import `CATEGORIES` from `./prompt.js`. Use the exact criteria text from the design. `buildClefRequest` normalizes the model with `resolveClefModel`. `classifyClef` uses:

```js
const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.cloudflareAccountId)}/ai/run/@cf/cloudflare/${model}`;
```

Send `Authorization: Bearer ${settings.cloudflareApiKey}`, `Content-Type: application/json`, and `AbortSignal.timeout(15000)`. On a non-OK response or `data.success === false`, throw an `Error` whose message joins `data.errors[].message`; set `err.status = res.status` and `err.quota = res.status === 429 || /neuron|quota|rate limit/i.test(message)`. If the body or category is malformed, throw `Cloudflare returned no valid category`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/clef.test.js`

Expected: PASS (6 tests).

- [ ] **Step 5: Update the npm test script**

Change `package.json`'s `test` script from `node --test tests/keywords.test.js` to `node --test tests`.

Run: `npm test`

Expected: all existing keyword tests plus the new Clef tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/clef.js tests/clef.test.js package.json
git commit -m "feat: add Cloudflare Clef protocol module"
```

If `package.json` contains the pre-existing `openai` dependency, stage the other files and leave `package.json` for the user.

---

### Task 2: Provider routing and backoff helpers

**Files:**
- Create: `src/shared/routing.js`
- Create: `tests/routing.test.js`

**Interfaces:**
- Produces:
  - `providerOrder(input: { nanoStatus: { availability: string, arabic: boolean } | null, arabic: boolean, hasClef: boolean, hasGroq: boolean }): string[]`
  - `clefBackoffUntil(err: { status?: number, quota?: boolean }, now?: number): number` — returns `0`, a UTC timestamp, or `Infinity`.

- [ ] **Step 1: Write the failing tests**

Create `tests/routing.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/shared/routing.js');

test('providerOrder puts Clef before Groq and keeps Nano first when usable', async () => {
  const { providerOrder } = await load();
  const nanoEn = { availability: 'available', arabic: false };
  const nanoAr = { availability: 'available', arabic: true };

  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: true, hasGroq: true }),
    ['nano', 'clef', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoAr, arabic: true, hasClef: true, hasGroq: true }),
    ['nano', 'clef', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: true, hasClef: true, hasGroq: true }),
    ['clef', 'groq', 'nano'],
  );
});

test('providerOrder preserves the old chain when Clef is absent', async () => {
  const { providerOrder } = await load();
  const nanoEn = { availability: 'available', arabic: false };

  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: false, hasGroq: true }),
    ['nano', 'groq'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: nanoEn, arabic: false, hasClef: false, hasGroq: false }),
    ['nano'],
  );
  assert.deepEqual(
    providerOrder({ nanoStatus: null, arabic: false, hasClef: true, hasGroq: false }),
    ['clef'],
  );
});

test('clefBackoffUntil handles auth, quota, and transient errors', async () => {
  const { clefBackoffUntil } = await load();
  const now = Date.UTC(2026, 9, 23, 15, 30);

  assert.equal(clefBackoffUntil({ status: 401 }, now), Infinity);
  assert.equal(clefBackoffUntil({ status: 403 }, now), Infinity);
  assert.equal(clefBackoffUntil({ status: 429 }, now), Date.UTC(2026, 9, 24));
  assert.equal(clefBackoffUntil({ status: 500 }, now), 0);
  assert.equal(clefBackoffUntil(new Error('network'), now), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/routing.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/shared/routing.js`**

`providerOrder` uses exactly the condition from the design:

```js
const nanoOk = nanoStatus?.availability === 'available';
const order = [];
if (nanoOk && (nanoStatus.arabic || !arabic || (!hasClef && !hasGroq))) order.push('nano');
if (hasClef) order.push('clef');
if (hasGroq) order.push('groq');
if (nanoOk && !order.includes('nano')) order.push('nano');
return order;
```

`clefBackoffUntil` returns `Infinity` for `401`/`403`, the next UTC midnight for `429` or `quota`, and `0` otherwise.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/routing.test.js`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/routing.js tests/routing.test.js
git commit -m "feat: add provider routing and Clef backoff helpers"
```

---

### Task 3: Settings defaults and manifest permission

**Files:**
- Modify: `src/shared/settings.js`
- Modify: `manifest.json`
- Create: `tests/config.test.js`

**Interfaces:**
- Produces: `DEFAULT_SETTINGS` with `useClef`, `cloudflareAccountId`, `cloudflareApiKey`, `clefModel`.
- Produces: `host_permissions` containing `https://api.cloudflare.com/*`.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

test('Cloudflare settings defaults are present', async () => {
  const { DEFAULT_SETTINGS } = await import('../src/shared/settings.js');
  assert.equal(DEFAULT_SETTINGS.useClef, true);
  assert.equal(DEFAULT_SETTINGS.cloudflareAccountId, '');
  assert.equal(DEFAULT_SETTINGS.cloudflareApiKey, '');
  assert.equal(DEFAULT_SETTINGS.clefModel, 'clef-flash');
});

test('manifest grants the Cloudflare host permission', () => {
  const manifest = require('../manifest.json');
  assert.ok(manifest.host_permissions.includes('https://api.cloudflare.com/*'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/config.test.js`

Expected: FAIL on the missing settings and host permission.

- [ ] **Step 3: Implement the settings and manifest changes**

Add to `DEFAULT_SETTINGS` before `groqKey`:

```js
useClef: true,
cloudflareAccountId: '',
cloudflareApiKey: '',
clefModel: 'clef-flash',
```

Add `"https://api.cloudflare.com/*"` to `manifest.json`'s `host_permissions` array.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/config.test.js`

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings.js manifest.json tests/config.test.js
git commit -m "feat: add Cloudflare settings and host permission"
```

---

### Task 4: Wire Clef into the background classifier

**Files:**
- Modify: `src/background.js`

**Interfaces:**
- Consumes: `classifyClef` from `./shared/clef.js`.
- Consumes: `providerOrder`, `clefBackoffUntil` from `./shared/routing.js`.
- Produces: `classify` results that include `confidence: number|null`.

- [ ] **Step 1: Add imports and the block timer**

At the top of `src/background.js`, add:

```js
import { classifyClef } from './shared/clef.js';
import { clefBackoffUntil, providerOrder } from './shared/routing.js';
```

Near `nanoStatus`, add:

```js
let clefBlockedUntil = 0;
```

- [ ] **Step 2: Replace the provider-order block in `runLLMChain`**

Replace the body from `const nano = ...` through the `order` construction with:

```js
const settings = await getSettings();
const nano = settings.useNano ? await getNanoStatus() : null;
const hasClef =
  settings.useClef &&
  Boolean(settings.cloudflareAccountId) &&
  Boolean(settings.cloudflareApiKey) &&
  Date.now() >= clefBlockedUntil;
const hasGroq = Boolean(settings.groqKey);
const order = providerOrder({ nanoStatus: nano, arabic, hasClef, hasGroq });
```

- [ ] **Step 3: Replace the loop dispatch**

```js
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
```

- [ ] **Step 4: Carry confidence through `classify`**

In `classify`, destructure confidence and include it in the cached result:

```js
const { category, source, confidence = null } = await enqueue(() => runLLMChain(prepareText(text), arabic));
const result = { category, keep: category ? KEEP_CATEGORIES.has(category) : null, source, confidence };
```

- [ ] **Step 5: Verify syntax and tests**

Run:

```powershell
Get-Content -Raw src/background.js | node --input-type=module --check
npm test
```

Expected: syntax check exits 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background.js
git commit -m "feat: add Clef to the background classifier chain"
```

---

### Task 5: Cloudflare popup section

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup.css` (only if the new block needs spacing)
- Create: `tests/popup.test.js`

**Interfaces:**
- Consumes: existing `initSettings()` field loop.
- Produces: DOM IDs `useClef`, `cloudflareAccountId`, `cloudflareApiKey`, `clefModel`.

- [ ] **Step 1: Write the failing test**

Create `tests/popup.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('src/popup/popup.html', 'utf8');
const js = fs.readFileSync('src/popup/popup.js', 'utf8');

test('Cloudflare fields exist in the popup', () => {
  for (const id of ['useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('Cloudflare section comes before Groq', () => {
  assert.match(html, /Cloudflare Clef \(primary\)/i);
  assert.match(html, /Groq \(secondary fallback\)/i);
  assert.ok(html.indexOf('Cloudflare Clef (primary)') < html.indexOf('Groq (secondary fallback)'));
});

test('popup FIELDS include the Cloudflare settings', () => {
  for (const key of ['useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel']) {
    assert.match(js, new RegExp(`'${key}'`));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/popup.test.js`

Expected: FAIL because the Cloudflare section and fields do not exist.

- [ ] **Step 3: Add the Cloudflare section to `popup.html`**

Insert before the Groq section:

```html
<section>
  <h2>Cloudflare Clef (primary)</h2>
  <label class="row"><input type="checkbox" id="useClef" /> Use Cloudflare for unclear posts</label>
  <label>Account ID <input type="text" id="cloudflareAccountId" placeholder="Cloudflare account ID" autocomplete="off" /></label>
  <label>API token <input type="password" id="cloudflareApiKey" placeholder="Workers AI token" autocomplete="off" /></label>
  <label>
    Model
    <select id="clefModel">
      <option value="clef-flash">Clef Flash — fast, free-tier friendly</option>
      <option value="clef">Clef — highest precision</option>
      <option value="clef-omni">Clef Omni — multimodal</option>
    </select>
  </label>
  <p class="muted">Free tier: 10,000 neurons/day. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Create a token</a>.</p>
</section>
```

Change the Groq heading from `Groq fallback (free tier)` to `Groq (secondary fallback)`.

- [ ] **Step 4: Add the new fields to `popup.js`**

Extend `FIELDS`:

```js
const FIELDS = [
  'enabled', 'hideMode', 'hidePromoted', 'showBadges',
  'useNano', 'useClef', 'cloudflareAccountId', 'cloudflareApiKey', 'clefModel',
  'groqKey', 'groqModel', 'ambiguousPolicy',
];
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/popup.test.js`

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/popup/popup.html src/popup/popup.js src/popup/popup.css tests/popup.test.js
git commit -m "feat: add Cloudflare Clef settings to the popup"
```

---

### Task 6: Confidence in post badges

**Files:**
- Create: `src/content/format.js`
- Modify: `src/content/content.js`
- Modify: `manifest.json` (content script order)
- Create: `tests/format.test.js`

**Interfaces:**
- Produces: `LIF.format.formatConfidence(value: unknown): string | null`
- Produces: `LIF.format.badgeLabel(category: string, source: string, confidence: unknown): string`

- [ ] **Step 1: Write the failing test**

Create `tests/format.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../src/content/format.js');

const { badgeLabel, formatConfidence } = globalThis.LIF.format;

test('formatConfidence renders percentages and ignores missing values', () => {
  assert.equal(formatConfidence(0.873), '87%');
  assert.equal(formatConfidence(0), '0%');
  assert.equal(formatConfidence(null), null);
  assert.equal(formatConfidence('0.9'), null);
});

test('badgeLabel omits missing parts', () => {
  assert.equal(badgeLabel('opportunity', 'clef', 0.91), 'opportunity · clef · 91%');
  assert.equal(badgeLabel('promoted', 'ad', null), 'promoted · ad');
  assert.equal(badgeLabel(undefined, undefined, undefined), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/format.test.js`

Expected: FAIL with `Cannot read properties of undefined (reading 'badgeLabel')`.

- [ ] **Step 3: Implement `src/content/format.js`**

Use the same classic-script pattern as `keywords.js`:

```js
(function (root) {
  const LIF = (root.LIF = root.LIF || {});

  function formatConfidence(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? `${Math.round(value * 100)}%`
      : null;
  }

  function badgeLabel(category, source, confidence) {
    return [category, source, formatConfidence(confidence)].filter(Boolean).join(' · ');
  }

  LIF.format = { formatConfidence, badgeLabel };
})(globalThis);
```

- [ ] **Step 4: Wire it into `content.js`**

- At the top: `const { badgeLabel } = LIF.format;`
- In `render`, read `lifConfidence` and build the label with `badgeLabel`.
- Extend `setState(post, state, category, source, confidence = null)` to set `post.dataset.lifConfidence = String(confidence)` when non-null, and `delete post.dataset.lifConfidence` otherwise.
- Pass `res.confidence` from the Clef result: `setState(post, res.keep ? 'kept' : 'hidden', res.category, res.source, res.confidence);`

- [ ] **Step 5: Load `format.js` before `content.js`**

Change the manifest content-script array to:

```json
"js": ["src/content/keywords.js", "src/content/selectors.js", "src/content/format.js", "src/content/content.js"]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/format.test.js`

Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/content/format.js src/content/content.js manifest.json tests/format.test.js
git commit -m "feat: show classifier confidence in post badges"
```

---

### Task 7: Live evaluation script and README

**Files:**
- Create: `tests/clef_live.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `classifyClef`, `CLEF_MODELS` from `src/shared/clef.js`; `KEEP_CATEGORIES` from `src/shared/prompt.js`.
- Produces: a manual script that prints category, confidence, latency, and keep/hide match per model.

- [ ] **Step 1: Create `tests/clef_live.mjs`**

The script must:

- Read `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (fall back to `CLOUDFLARE_API_KEY`). Exit with code 2 and a clear message if either is missing.
- Use this smoke set plus all three fixture posts:

```js
const cases = [
  ['keep', "We're hiring a Senior Backend Engineer in Riyadh. Send your CV to jobs@acme.com"],
  ['keep', 'Join us on Nov 12 for a free webinar on Kubernetes security. Register here.'],
  ['keep', 'Use promo code LAUNCH for 40% off our course this week only.'],
  ['hide', '5 tips to land your dream job: network, tailor your resume, follow up.'],
  ['hide', "I'm thrilled to share that I'm starting a new position as Data Analyst at Acme!"],
  ['hide', 'Dear recruiters, ghosting candidates after 4 interviews is unacceptable.'],
  ['keep', 'نحن نوظف! مطلوب مهندس برمجيات. للتقديم أرسل سيرتك الذاتية'],
  ['keep', 'يسرّنا دعوتكم لحضور ورشة عمل مجانية عن الذكاء الاصطناعي، سجّل الآن'],
  ['hide', '٥ نصائح للحصول على وظيفة أحلامك'],
  ['hide', 'الحمد لله، يسعدني أن أعلن انضمامي إلى شركة أكمي'],
];
```

- For each model in `CLEF_MODELS`, call `classifyClef` for every case and fixture, print `model`, `keep`/`hide`, category, confidence, latency in ms, and the first 40 characters.
- Print a final `model: matched/total keep-hide matches` line.
- Do not write to the extension cache.

- [ ] **Step 2: Verify the script parses**

Run: `node --check tests/clef_live.mjs`

Expected: exits 0.

- [ ] **Step 3: Run the live evaluation if credentials are available**

Run: `node tests/clef_live.mjs`

Expected: three model headers, one line per case, and match totals. If credentials are absent, note that the live check was skipped.

- [ ] **Step 4: Update `README.md`**

- Change the classification ladder to: ads → keywords → Gemini Nano → Cloudflare Clef → Groq → fallback.
- Add Cloudflare to the install steps: create a Workers AI API token, paste the account ID and token, choose a model.
- Note the free tier: 10,000 neurons/day; `clef-flash` is the default; `clef` is higher precision; `clef-omni` is multimodal and unnecessary for text.
- Mention that the confidence percentage appears in badges when labeling is enabled.
- Add a privacy sentence: enabling Cloudflare or Groq sends post text to that provider.
- Keep the existing tuning and stale-selector sections.

- [ ] **Step 5: Commit**

```bash
git add tests/clef_live.mjs README.md
git commit -m "docs: document Cloudflare Clef and add live evaluation script"
```

---

### Task 8: Full verification

**Files:**
- No new files. Inspect the working tree and run the full suite.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all keyword, Clef, routing, config, popup, and formatting tests pass.

- [ ] **Step 2: Syntax-check the changed ES modules**

Run:

```powershell
Get-Content -Raw src/background.js | node --input-type=module --check
Get-Content -Raw src/shared/clef.js | node --input-type=module --check
Get-Content -Raw src/shared/routing.js | node --input-type=module --check
Get-Content -Raw src/popup/popup.js | node --input-type=module --check
```

Expected: every command exits 0.

- [ ] **Step 3: Validate the manifest and content-script order**

Run:

```powershell
node -e "const m=require('./manifest.json'); console.log(m.host_permissions, m.content_scripts[0].js)"
```

Expected: `https://api.cloudflare.com/*` is present, and `format.js` appears before `content.js`.

- [ ] **Step 4: Inspect the working tree**

Run: `git status --short`

Expected: only intended feature files are staged or modified. Do not stage `.gitignore`, `bun.lock`, `node_modules/`, `test-clef.js`, the `openai` dependency, or the `keywords.js` newline change.

- [ ] **Step 5: Manual browser smoke test**

Load the unpacked extension in Chrome 138+, open the popup, enter a Cloudflare account ID and Workers AI token, select `clef-flash`, then open the LinkedIn feed. Expected: ambiguous posts are classified and show a `clef` badge with a percentage when labeling is enabled. Clear the token and confirm the old Nano/Groq behavior returns.

- [ ] **Step 6: Final commit**

```bash
git add src/shared/clef.js src/shared/routing.js src/shared/settings.js src/background.js src/popup/popup.html src/popup/popup.js src/popup/popup.css src/content/format.js src/content/content.js manifest.json README.md tests/clef.test.js tests/routing.test.js tests/config.test.js tests/popup.test.js tests/format.test.js tests/clef_live.mjs docs/superpowers/specs/2026-10-23-clef-cloudflare-provider-design.md docs/superpowers/plans/2026-10-23-clef-cloudflare-provider.md
git commit -m "feat: add Cloudflare Clef as the primary cloud classifier"
```

If there is nothing left to commit, say so. Do not stage unrelated user changes.
