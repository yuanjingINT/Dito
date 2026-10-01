/**
 * Dito 的上下文压缩预算。
 *
 * pi-coding-agent 以 reserveTokens / keepRecentTokens 表达压缩策略，
 * 而 DeepSeek Harness 以窗口比例、输出预留和保留比例表达策略。
 * 这里负责把后者转换为前者，实际的摘要、会话树和溢出重试仍由 pi 处理。
 */

export interface ContextCompactionConfig {
  /** 是否启用自动压缩与上下文溢出恢复。 */
  enabled: boolean;
  /** 达到上下文窗口的这个比例后开始压缩。 */
  thresholdRatio: number;
  /** 保留最近对话占「窗口 - 最大输出」的比例。 */
  retainRatio: number;
  /** 为摘要与模型输出额外保留的 token 数。 */
  headroomTokens: number;
}

export const DEFAULT_CONTEXT_COMPACTION: ContextCompactionConfig = {
  enabled: true,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  headroomTokens: 65_536,
};

export interface CompactionBudget {
  enabled: boolean;
  /** pi 的触发条件为 contextTokens > contextWindow - reserveTokens。 */
  reserveTokens: number;
  /** 压缩后从历史尾部原样保留的 token 预算。 */
  keepRecentTokens: number;
  /** 便于诊断和测试的实际触发阈值。 */
  thresholdTokens: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 按 DeepSeek Harness 的策略计算 pi 所需的压缩预算。
 *
 * 触发阈值：floor(min(W * thresholdRatio, W - O - headroomTokens))。
 * 当模型声明的最大输出已经占满窗口时，仍使用比例阈值，避免压缩被禁用。
 */
export function resolveCompactionBudget(
  model: { contextWindow?: number; maxTokens?: number },
  config?: Partial<ContextCompactionConfig> | null,
): CompactionBudget {
  const settings = config && typeof config === "object" ? config : {};
  const window = Math.max(1, Math.floor(finiteNumber(model.contextWindow, 128_000)));
  const output = clamp(Math.floor(finiteNumber(model.maxTokens, 16_384)), 0, window);
  const thresholdRatio = clamp(finiteNumber(settings.thresholdRatio, DEFAULT_CONTEXT_COMPACTION.thresholdRatio), 0.05, 0.99);
  const retainRatio = clamp(finiteNumber(settings.retainRatio, DEFAULT_CONTEXT_COMPACTION.retainRatio), 0, 0.8);
  const headroomTokens = Math.max(0, Math.floor(finiteNumber(settings.headroomTokens, DEFAULT_CONTEXT_COMPACTION.headroomTokens)));

  const ratioThreshold = Math.floor(window * thresholdRatio);
  const capacityThreshold = window - output - headroomTokens;
  const thresholdTokens = Math.max(1, Math.min(ratioThreshold, capacityThreshold > 0 ? capacityThreshold : ratioThreshold));
  const reserveTokens = Math.max(1, window - thresholdTokens);
  const retainedCapacity = Math.max(0, window - output);
  const keepRecentTokens = Math.max(0, Math.min(thresholdTokens - 1, Math.floor(retainedCapacity * retainRatio)));

  return {
    enabled: settings.enabled === undefined ? DEFAULT_CONTEXT_COMPACTION.enabled : settings.enabled === true,
    reserveTokens,
    keepRecentTokens,
    thresholdTokens,
  };
}
