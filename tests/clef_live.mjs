// Manual evaluation of the Cloudflare Clef models against the known cases.
// Not part of `npm test`: it makes real API calls. Run it with:
//   node tests/clef_live.mjs
// Credentials come from the environment or the repo's .env file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLEF_MODELS, classifyClef } from '../src/shared/clef.js';
import { KEEP_CATEGORIES } from '../src/shared/prompt.js';

try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'));
} catch {
  // No .env file; fall back to the process environment.
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiKey = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY;
if (!accountId || !apiKey) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or CLOUDFLARE_API_KEY) to run the live evaluation.');
  process.exit(2);
}

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

// The recorded feed: an Egyptian junior-market rant, generic corporate marketing,
// and a free-subscription offer.
const feed = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'feed-2026-10-20.json'), 'utf8'),
);
const feedExpected = ['hide', 'hide', 'keep'];
for (const [i, post] of feed.entries()) cases.push([feedExpected[i], post.text]);

const preview = (text) => text.replace(/\s+/g, ' ').slice(0, 40);
const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—');

for (const model of CLEF_MODELS) {
  console.log(`\n${model}`);
  let matched = 0;
  for (const [expected, text] of cases) {
    const started = Date.now();
    try {
      const result = await classifyClef(text, {
        cloudflareAccountId: accountId,
        cloudflareApiKey: apiKey,
        clefModel: model,
      });
      const ms = Date.now() - started;
      const actual = KEEP_CATEGORIES.has(result.category) ? 'keep' : 'hide';
      if (actual === expected) matched++;
      console.log(
        `${actual === expected ? 'ok  ' : 'miss'} want ${expected} got ${actual} ${result.category} ${pct(result.confidence)} ${ms}ms "${preview(text)}"`,
      );
    } catch (err) {
      const ms = Date.now() - started;
      console.log(`err  want ${expected} ${ms}ms ${err.message} "${preview(text)}"`);
    }
  }
  console.log(`${model}: ${matched}/${cases.length} keep-hide matches`);
}
