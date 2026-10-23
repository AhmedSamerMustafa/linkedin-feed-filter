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
