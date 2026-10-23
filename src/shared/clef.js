// Cloudflare Workers AI "Clef" classifier. Shared by the background service worker
// and the manual evaluation script in tests/clef_live.mjs.

import { CATEGORIES } from './prompt.js';

export const CLEF_MODELS = ['clef-flash', 'clef'];
export const DEFAULT_CLEF_MODEL = 'clef-flash';

const CRITERIA = {
  opportunity: 'The author offers a concrete job, internship, scholarship, grant, or call for applications',
  offer: 'The author offers something the reader can claim: free access, discount, promo code, giveaway',
  event: 'An invitation to an upcoming webinar, workshop, meetup, conference, or live session',
  advice: 'Tips, lessons, how-tos, opinions, or motivational content',
  story: 'Personal stories, career updates, celebrations, or event recaps',
  complaint: 'Rants about companies, recruiters, or hiring processes',
  other: 'Anything else',
};

const TIMEOUT_MS = 15000;

export function resolveClefModel(model) {
  return CLEF_MODELS.includes(model) ? model : DEFAULT_CLEF_MODEL;
}

export function buildClefRequest(text, model) {
  const resolved = resolveClefModel(model);
  return {
    model: resolved,
    state: text,
    questions: {
      category: {
        type: 'choice',
        instructions: 'Which category best describes this LinkedIn post?',
        criteria: Object.fromEntries(CATEGORIES.map((category) => [category, CRITERIA[category]])),
      },
    },
  };
}

export function parseClefResponse(data) {
  if (!data || data.success === false) return null;
  const answer = data.result?.answers?.category;
  if (!answer || !CATEGORIES.includes(answer.choice)) return null;
  return {
    category: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object'
      ? answer.probabilities
      : null,
  };
}

export async function classifyClef(text, settings) {
  const model = resolveClefModel(settings.clefModel);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.cloudflareAccountId)}/ai/run/@cf/cloudflare/${model}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.cloudflareApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildClefRequest(text, model)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || data?.success === false) {
    const message = (data?.errors || [])
      .map((error) => error?.message)
      .filter(Boolean)
      .join('; ') || `Cloudflare request failed with status ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.quota = res.status === 429 || /neuron|quota|rate limit/i.test(message);
    throw err;
  }

  const parsed = parseClefResponse(data);
  if (!parsed) throw new Error('Cloudflare returned no valid category');
  return parsed;
}
