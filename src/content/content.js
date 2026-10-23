(() => {
  const { classify: keywordClassify, isMostlyArabic, normalize } = LIF.keywords;
  const { badgeLabel } = LIF.format;
  const SEL = LIF.selectors;

  const TEXT_WAIT_MS = 3000;

  let settings = null;
  let warnedStaleSelectors = false;
  const stats = { kept: 0, hidden: 0, pending: 0, bySource: {} };

  const isFeed = () => location.pathname.startsWith('/feed');

  // ---------- Settings ----------

  async function loadSettings() {
    settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
    const html = document.documentElement;
    html.toggleAttribute('data-lif-off', !settings.enabled);
    html.dataset.lifMode = settings.hideMode;
    html.toggleAttribute('data-lif-badges', settings.showBadges);
  }

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || Object.keys(changes).every((k) => k === 'llmCache')) return;
    await loadSettings();
    scheduleScan();
  });

  // ---------- Post helpers ----------

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return `h${(h >>> 0).toString(36)}`;
  }

  function postUrn(post) {
    for (const attr of SEL.keyAttrs) {
      const value = post.getAttribute(attr);
      if (value) return value;
    }
    return null;
  }

  // Like textContent, but keeps <br> line breaks; LinkedIn separates lines with them,
  // and textContent would glue the last word of a line to the first word of the next.
  function elementText(el) {
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
      else if (node.tagName === 'BR') out += '\n';
    }
    return out.trim();
  }

  function isPromoted(container) {
    if (container.querySelector(SEL.adLink)) return true;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (!text || text.length > 40) continue;
      // A post body that happens to say "Promoted" is not an ad label.
      if (SEL.adLabel.test(normalize(text)) && !node.parentElement.closest(SEL.text)) return true;
    }
    return false;
  }

  function extractText(post) {
    const els = [...post.querySelectorAll(SEL.text)];
    const outermost = els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
    return outermost.map(elementText).filter(Boolean).join('\n\n');
  }

  function setBar(post, text, buttonLabel, onClick) {
    let bar = post.querySelector(':scope > .lif-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'lif-bar';
      post.prepend(bar);
    }
    bar.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
    if (buttonLabel) {
      const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: buttonLabel });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      bar.append(btn);
    }
  }

  function render(post) {
    const { lifState: state, lifCategory: category, lifSource: source, lifConfidence } = post.dataset;
    const confidence = lifConfidence === undefined ? null : Number(lifConfidence);
    const label = badgeLabel(category, source, confidence);
    if (state === 'pending') setBar(post, 'Checking post…');
    else if (state === 'hidden') {
      setBar(post, `Hidden: ${label}`, 'Show', () => {
        post.dataset.lifState = 'revealed';
        render(post);
      });
    } else if (state === 'revealed') {
      setBar(post, `Shown by you (${label})`, 'Hide', () => {
        post.dataset.lifState = 'hidden';
        render(post);
      });
    } else if (state === 'kept') setBar(post, `✓ ${label}`);
  }

  function setState(post, state, category, source, confidence = null) {
    const prev = post.dataset.lifState;
    if (prev === 'pending') stats.pending--;
    if (state === 'pending') stats.pending++;
    if (state === 'kept') stats.kept++;
    if (state === 'hidden') stats.hidden++;
    if (source && state !== 'pending') stats.bySource[source] = (stats.bySource[source] || 0) + 1;

    post.dataset.lifState = state;
    if (category) post.dataset.lifCategory = category;
    if (source) post.dataset.lifSource = source;
    if (confidence !== null && confidence !== undefined) post.dataset.lifConfidence = String(confidence);
    else delete post.dataset.lifConfidence;
    render(post);
  }

  // ---------- Classification ----------

  async function processPost(post) {
    const urn = postUrn(post);
    // Already handled, unless LinkedIn recycled the element for a different post.
    if (post.dataset.lifState && post.dataset.lifUrn === (urn ?? '')) {
      if (!post.querySelector(':scope > .lif-bar')) render(post); // LinkedIn re-rendered and dropped our bar
      return;
    }

    if (settings.hidePromoted && isPromoted(post)) {
      post.dataset.lifUrn = urn ?? '';
      setState(post, 'hidden', 'promoted', 'ad');
      return;
    }

    let text = extractText(post);
    if (!text) {
      // Post text can render after the container; give it a moment before falling back.
      post.dataset.lifSeen ??= Date.now();
      if (Date.now() - Number(post.dataset.lifSeen) < TEXT_WAIT_MS) {
        setTimeout(scheduleScan, TEXT_WAIT_MS / 3);
        return;
      }
      text = post.innerText.trim();
      if (!warnedStaleSelectors) {
        warnedStaleSelectors = true;
        console.warn('[LIF] No post text found with selectors.text; LinkedIn may have changed its markup.', post);
      }
    }

    post.dataset.lifUrn = urn ?? '';
    const kw = keywordClassify(text);
    if (kw.verdict !== 'ambiguous') {
      setState(post, kw.verdict === 'keep' ? 'kept' : 'hidden', kw.category, 'keywords');
      return;
    }

    setState(post, 'pending');
    const key = urn ?? hashText(text);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'classify', key, text, arabic: isMostlyArabic(text) });
    } catch (err) {
      res = { error: String(err) };
    }
    if (post.dataset.lifUrn !== (urn ?? '')) return; // element was reused while we waited

    if (res?.category) {
      setState(post, res.keep ? 'kept' : 'hidden', res.category, res.source, res.confidence);
      return;
    }
    // No LLM available: go with whichever side the keywords leaned to.
    const decision = kw.lean ?? settings.ambiguousPolicy;
    setState(post, decision === 'keep' ? 'kept' : 'hidden', kw.category ?? 'unsure', 'fallback');
  }

  // Ads that don't use the normal post wrapper: check each feed item directly.
  function scanFeedItemsForAds() {
    const feed = document.querySelector(SEL.feed);
    if (!feed) return;
    for (const item of feed.children) {
      if (item.dataset.lifState || item.dataset.lifAdChecked) {
        if (item.dataset.lifState && !item.querySelector(':scope > .lif-bar')) render(item);
        continue;
      }
      if (item.querySelector(SEL.post)) continue; // processPost handles normal posts, ads included
      if (!item.textContent.trim()) continue; // lazy placeholder; check again once it mounts
      if (isPromoted(item)) setState(item, 'hidden', 'promoted', 'ad');
      else item.dataset.lifAdChecked = '1';
    }
  }

  function scan() {
    if (!settings?.enabled || !isFeed()) return;
    for (const post of document.querySelectorAll(SEL.post)) {
      if (post.parentElement?.closest(SEL.post)) continue; // only outermost post containers
      processPost(post);
    }
    if (settings.hidePromoted) scanFeedItemsForAds();
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'stats') sendResponse({ ...stats, onFeed: isFeed(), enabled: settings?.enabled });
    return false;
  });

  loadSettings().then(() => {
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
    scan();
  });
})();
