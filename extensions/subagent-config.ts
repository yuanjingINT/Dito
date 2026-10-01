/** 子代理调度配置。 */
export interface SubagentConfig {
  enabled: boolean;
  /** 单个主代理回合允许持有的子代理上限。硬上限为 100。 */
  maxAgents: number;
  /** 同时运行的子代理进程数，不能超过 maxAgents。 */
  maxConcurrency: number;
  /** 自动选模时每个任务允许的估算美元预算；0 表示不设预算。 */
  defaultBudgetUsd: number;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  enabled: true,
  maxAgents: 100,
  maxConcurrency: 8,
  defaultBudgetUsd: 0,
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读取配置并限制资源上限，避免旧配置或手写配置突破 100 个子代理。 */
export function resolveSubagentConfig(raw: unknown): SubagentConfig {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const maxAgents = Math.max(1, Math.min(100, Math.floor(finiteNumber(source.maxAgents, DEFAULT_SUBAGENT_CONFIG.maxAgents))));
  return {
    enabled: source.enabled !== false,
    maxAgents,
    maxConcurrency: Math.max(1, Math.min(maxAgents, Math.floor(finiteNumber(source.maxConcurrency, DEFAULT_SUBAGENT_CONFIG.maxConcurrency)))),
    defaultBudgetUsd: Math.max(0, finiteNumber(source.defaultBudgetUsd, DEFAULT_SUBAGENT_CONFIG.defaultBudgetUsd)),
  };
}
