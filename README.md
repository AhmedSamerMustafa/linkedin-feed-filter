# LinkedIn Feed Filter

Chrome extension that hides LinkedIn home-feed posts unless they're an **opportunity**, **offer**, or **event announcement**. Works with English and Arabic posts, and costs nothing to run.

## How a post is classified

0. **Ads.** Promoted posts are hidden first, with no AI call. They're detected by the "Promoted" header label (English or Arabic) or by ad-tracking links (`li_fat_id`). This works even when an ad doesn't use the normal post wrapper. You can toggle it in the popup.
1. **Keywords** (`src/content/keywords.js`). Weighted English and Arabic rules score each post on a "keep" side and a "hide" side. Clear cases are decided instantly. Arabic text is normalized first (diacritics, tatweel, أ/إ/آ→ا, ة→ه, ى→ي), and LinkedIn's fancy unicode bold text is folded back to plain letters.
2. **Gemini Nano** (Chrome's on-device AI). Ambiguous posts go here first. It runs locally, free and private.
3. **Cloudflare Clef** (Workers AI, free tier). The preferred cloud classifier. Used when Nano is unavailable or fails, and only if you've added an account ID and API token. Arabic posts go to Clef first when your Nano model doesn't support Arabic.
4. **Groq** (free tier). Secondary fallback, used only if Clef is unavailable or fails, and only if you've added a Groq key.
5. **Fallback.** If no AI is available, the post follows whichever side the keywords leaned toward. If they're tied, it follows the "undecided posts" setting.

AI results are cached per post, so a post is never classified twice.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open the extension popup. If Gemini Nano shows "not downloaded", click **Download model**.
4. Optional: add Cloudflare. Create a Workers AI API token at https://dash.cloudflare.com/profile/api-tokens, paste your account ID and the token into the popup, and pick a model.
5. Optional: paste a free Groq key from https://console.groq.com/keys as a secondary fallback.

Gemini Nano needs Chrome 138+, about 22 GB of free disk space, and either a GPU with more than 4 GB of VRAM or 16 GB of RAM.

### Choosing a Clef model

- **Clef Flash** (default) — fast and the easiest on the 10,000 neurons/day free tier.
- **Clef** — highest precision, slightly more expensive per call.

Switching models does not clear the cache. Use **Clear AI cache** if you want posts reclassified by the new model.

## Tuning

- **Wrong decisions:** turn on "Label kept posts" in the popup. Every post then shows which category it got, which layer decided it (`keywords`, `nano`, `clef`, `groq`, `fallback`), and the classifier's confidence when it reported one (for example `opportunity · clef · 91%`). Fix bad keyword decisions in `src/content/keywords.js` and add a test case to `tests/keywords.test.js`. Run `npm test`.
- **Clef accuracy:** run `node tests/clef_live.mjs` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_API_KEY`) set, or in `.env`. It evaluates all three models against the English, Arabic, and recorded-feed cases without touching the extension cache.
- **Filter stopped working:** LinkedIn probably changed its markup. Save the feed page (Ctrl+S), run `python3 tests/saved_feed_check.py "Feed _ LinkedIn.html"` (needs Python Playwright), and update `src/content/selectors.js` until every post gets a state. The console also warns `[LIF] No post text found…` when the text selectors stop matching.
- **LLM behavior:** edit the prompt in `src/shared/prompt.js`. Nano, Cloudflare, and Groq share it.

## Privacy

Classification happens in your browser until a cloud provider is needed. Enabling Cloudflare Clef sends the post text to Cloudflare; enabling Groq sends it to Groq. Both are opt-in and use your own credentials. The API token and Groq key are stored unencrypted in `chrome.storage.local`, exactly like any other extension setting. The extension never ships a shared key and there is no backend.
