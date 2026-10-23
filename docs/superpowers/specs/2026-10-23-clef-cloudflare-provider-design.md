# Cloudflare Clef Provider — Design

**Date:** 2026-10-23
**Status:** Approved

## Intent

Add Cloudflare Workers AI as the preferred cloud classifier, using Clef's typed
decision API. Users bring their own Cloudflare account ID and API token.
`clef-flash` is the default; `clef` and `clef-omni` are selectable. Groq remains
as the secondary cloud provider, and the local-first chain stays intact:

**keywords → Gemini Nano (when available) → Cloudflare Clef → Groq → keyword lean / `ambiguousPolicy`**

## Goals

- One Cloudflare provider supporting `clef-flash`, `clef`, and `clef-omni`.
- Cloudflare tried before Groq whenever it is configured.
- BYO credentials, matching the existing Groq-key pattern.
- Keep the existing cache, queue, fallback, and ad detection untouched.
- Make confidence visible for tuning.
- Automated tests for the request builder, response parser, and provider order.

## Non-goals

- No Worker proxy, shared key, or backend.
- No local 0.8B Jev-Style model.
- No audio/video despite `clef-omni` supporting it.
- No confidence-based routing in v1 (record it, do not gate on it).
- No automatic provider benchmarking inside the extension.

## Approaches considered

### A. Direct integration (chosen)

A small `src/shared/clef.js` exposes the request builder, response parser, and
fetch call. `background.js` adds `clef` as one source in `runLLMChain`.
Settings and popup gain Cloudflare fields. This is the smallest diff and fits
the project's no-build, plain-JavaScript style.

Trade-off: one more provider-specific branch in `runLLMChain`.

### B. Provider registry

A `src/shared/providers.js` list of `{ id, enabled, classify }` entries, with
`runLLMChain` iterating. Cleaner if many providers are expected, but refactors
working code and adds indirection for only two cloud services.

### C. Worker proxy

The extension calls a Worker that holds the Cloudflare token. Zero setup for
users, but one free tier is shared by everyone, with abuse and rate-limit risk,
and a backend to deploy. Rejected because it contradicts "free per user".

## Decisions

1. **Nano stays first.** "Primary" means primary cloud provider, not ahead of
   the local model.
2. **`clef-flash` is the default.** `clef` is the precision option;
   `clef-omni` is available but not recommended for text-only use.
3. **Confidence is recorded, not used for routing.** Clef's selected category
   is accepted. Confidence is cached and shown in badges when labeling is on.
4. **`useClef` defaults to `true`.** Nothing happens until both the account ID
   and API token are filled in.
5. **Quota failures back off until the next UTC midnight.** Credential failures
   disable Clef for the session.

## Request contract

```js
POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/cloudflare/{model}
Authorization: Bearer {apiKey}

{
  model: "clef-flash",
  state: text,
  questions: {
    category: {
      type: "choice",
      instructions: "Which category best describes this LinkedIn post?",
      criteria: {
        opportunity: "The author offers a concrete job, internship, scholarship, grant, or call for applications",
        offer: "The author offers something the reader can claim: free access, discount, promo code, giveaway",
        event: "An invitation to an upcoming webinar, workshop, meetup, conference, or live session",
        advice: "Tips, lessons, how-tos, opinions, or motivational content",
        story: "Personal stories, career updates, celebrations, or event recaps",
        complaint: "Rants about companies, recruiters, or hiring processes",
        other: "Anything else"
      }
    }
  }
}
```

`parseClefResponse` reads `result.answers.category.choice` and `.confidence`,
validates the category against `CATEGORIES`, and returns `null` for a malformed
envelope or an unknown category.

## Routing

```js
const hasClef =
  settings.useClef &&
  Boolean(settings.cloudflareAccountId) &&
  Boolean(settings.cloudflareApiKey) &&
  Date.now() >= clefBlockedUntil;
const hasGroq = Boolean(settings.groqKey);

if (nanoOk && (nano.arabic || !arabic || (!hasClef && !hasGroq))) order.push('nano');
if (hasClef) order.push('clef');
if (hasGroq) order.push('groq');
if (nanoOk && !order.includes('nano')) order.push('nano');
```

English and Arabic-with-Nano go **Nano → Clef → Groq**. Arabic when Nano lacks
Arabic goes **Clef → Groq → Nano**. If Cloudflare is disabled or unconfigured,
behavior is exactly today's.

## Failure handling

| Failure | Behavior |
| --- | --- |
| `401` / `403` | Log, disable Clef for the session, continue to Groq. |
| `429` / quota message | Disable Clef until the next UTC midnight, continue to Groq. |
| Timeout, network error, malformed response | Log, continue to Groq. |
| No cloud provider available | Existing keyword lean / `ambiguousPolicy` fallback. |

## UI

Cloudflare section comes first:

- Use Cloudflare (primary)
- Account ID
- API token (password field)
- Model dropdown: Clef Flash (default), Clef, Clef Omni

Groq heading becomes **Groq (secondary fallback)**. Existing fields stay
unchanged. Add a short muted note about the free tier and a link to create an
API token.

## Cache and badges

The cache key stays `urn || textHash`; cached entries also store `confidence`.
Switching models does not invalidate existing cache entries — "Clear AI cache"
remains the explicit reset. Badges show `category · source · 87%` when labeling
is enabled.

## Privacy and security

- The API token is stored in `chrome.storage.local`, unencrypted, exactly like
  the existing Groq key.
- Post text is sent to Cloudflare when Clef is enabled and to Groq when Groq is
  enabled. The README states this plainly.
- The extension never ships a shared key.

## Acceptance

- With valid Cloudflare credentials and Nano unavailable, an ambiguous post is
  classified by Clef and the badge says `clef`.
- With both Cloudflare and Groq configured, Clef is called first; Groq is only
  reached on Clef failure.
- With only Groq configured, current behavior is unchanged.
- All three models are selectable and send the correct model string.
- `npm test` passes, including new Clef parser, routing, config, popup, and
  formatting tests.
- A live evaluation script confirms accuracy on the existing English and Arabic
  fixtures before the provider is enabled by default.
