export const DEFAULT_SETTINGS = {
  enabled: true,
  hideMode: 'collapse', // 'collapse' leaves a thin "show" bar, 'remove' hides the post completely
  showBadges: false, // label kept posts with their category, useful while tuning
  hidePromoted: true, // hide ads before any keyword or AI check
  useNano: true,
  useClef: true,
  cloudflareAccountId: '',
  cloudflareApiKey: '',
  clefModel: 'clef-flash',
  groqKey: '',
  groqModel: 'qwen/qwen3.8-27b', // fastest of the free models in testing; no reasoning tokens
  ambiguousPolicy: 'keep', // used only when no LLM is available and keywords are tied
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}
