function resolveContextWindow(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}
function registerContextCompaction(pi, settingsManager, config) {
  const updateBudget = (_event, ctx) => {
    if (!ctx.model) return;
    const budget = resolveCompactionBudget(ctx.model, config);
    settingsManager.applyOverrides({ compaction: { enabled: budget.enabled, reserveTokens: budget.reserveTokens, keepRecentTokens: budget.keepRecentTokens } });
  };
  pi.on("session_start", updateBudget);
  pi.on("model_select", updateBudget);
}
const DEFAULT_CONTEXT_COMPACTION = {
  enabled: true,
  trimAtRatio: 0.8,
  trimBatchRatio: 0.15,
  reservedRatio: 0.1,
  minReservedTokens: 4096,
  compactTailTokens: 16384
};
function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function resolveCompactionBudget(model, config) {
  const settings = config && typeof config === "object" ? config : {};
  const window = resolveContextWindow(model.contextWindow);
  if (!Number.isFinite(window)) {
    return {
      enabled: settings.enabled !== false,
      reserveTokens: Math.max(1, Math.floor(finiteNumber(settings.minReservedTokens, DEFAULT_CONTEXT_COMPACTION.minReservedTokens))),
      keepRecentTokens: Math.max(1, Math.floor(finiteNumber(settings.compactTailTokens, DEFAULT_CONTEXT_COMPACTION.compactTailTokens))),
      thresholdTokens: Number.POSITIVE_INFINITY
    };
  }
  const trimAtRatio = clamp(
    finiteNumber(settings.trimAtRatio, finiteNumber(settings.thresholdRatio, DEFAULT_CONTEXT_COMPACTION.trimAtRatio ?? 0.8)),
    0.1,
    1
  );
  const reservedRatio = clamp(
    finiteNumber(settings.reservedRatio, DEFAULT_CONTEXT_COMPACTION.reservedRatio ?? 0.1),
    0,
    0.9
  );
  const minReservedTokens = Math.max(
    1,
    Math.floor(finiteNumber(settings.minReservedTokens, DEFAULT_CONTEXT_COMPACTION.minReservedTokens ?? 4096))
  );
  const reservedTokens = Math.max(minReservedTokens, Math.floor(window * reservedRatio));
  const thresholdTokens = Math.max(1, Math.floor(window * trimAtRatio));
  const reserveTokens = Math.max(1, window - thresholdTokens, reservedTokens);
  const requestedTail = Math.floor(
    finiteNumber(settings.compactTailTokens, DEFAULT_CONTEXT_COMPACTION.compactTailTokens ?? 16384)
  );
  const maxTailTokens = Math.max(1, Math.min(Math.floor(window / 2), window - reservedTokens));
  const keepRecentTokens = Math.max(1, Math.min(maxTailTokens, requestedTail));
  return {
    enabled: settings.enabled === void 0 ? DEFAULT_CONTEXT_COMPACTION.enabled : settings.enabled === true,
    reserveTokens,
    keepRecentTokens,
    thresholdTokens
  };
}
export {
  DEFAULT_CONTEXT_COMPACTION,
  registerContextCompaction,
  resolveCompactionBudget,
  resolveContextWindow
};
