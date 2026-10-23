// Pure routing decisions for the classifier chain. Kept free of extension APIs
// so the ordering rules can be tested without a browser.

const DAY_MS = 24 * 60 * 60 * 1000;

export function providerOrder({ nanoStatus, arabic, hasClef, hasGroq }) {
  const nanoOk = nanoStatus?.availability === 'available';
  const order = [];
  if (nanoOk && (nanoStatus.arabic || !arabic || (!hasClef && !hasGroq))) order.push('nano');
  if (hasClef) order.push('clef');
  if (hasGroq) order.push('groq');
  if (nanoOk && !order.includes('nano')) order.push('nano');
  return order;
}

export function clefBackoffUntil(err, now = Date.now()) {
  const status = err?.status;
  if (status === 401 || status === 403) return Infinity;
  if (status === 429 || err?.quota) return Math.ceil(now / DAY_MS) * DAY_MS;
  return 0;
}
