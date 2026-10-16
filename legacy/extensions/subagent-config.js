const DEFAULT_SUBAGENT_CONFIG = {
  enabled: true,
  maxAgents: 100,
  maxConcurrency: 8,
  defaultBudgetUsd: 0
};
function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function resolveSubagentConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const maxAgents = Math.max(1, Math.min(100, Math.floor(finiteNumber(source.maxAgents, DEFAULT_SUBAGENT_CONFIG.maxAgents))));
  return {
    enabled: source.enabled !== false,
    maxAgents,
    maxConcurrency: Math.max(1, Math.min(maxAgents, Math.floor(finiteNumber(source.maxConcurrency, DEFAULT_SUBAGENT_CONFIG.maxConcurrency)))),
    defaultBudgetUsd: Math.max(0, finiteNumber(source.defaultBudgetUsd, DEFAULT_SUBAGENT_CONFIG.defaultBudgetUsd))
  };
}
export {
  DEFAULT_SUBAGENT_CONFIG,
  resolveSubagentConfig
};
