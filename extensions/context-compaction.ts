/**
 * 上下文窗口和压缩预算。
 *
 * 这套参数与 laozhou 保持一致：窗口达到 80% 时开始处理，响应预留窗口
 * 的 10%（至少 4096 token），压缩后固定保留最近 16384 token。pi 的
 * `reserveTokens` 同时决定触发线和摘要请求的输出预算，因此这里优先保持
 * laozhou 的触发线，再用 10% 预留约束尾部；模型的 `maxTokens` 仍由 pi
 * 自己做最终上限。
 */
import type { ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Unknown windows use an in-memory sentinel, never an invented token limit. */
export function resolveContextWindow(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.floor(value)
    : Number.POSITIVE_INFINITY;
}

/** Recalculate budgets after provider metadata and model selection handlers. */
export function registerContextCompaction(pi: ExtensionAPI, settingsManager: SettingsManager, config?: Partial<ContextCompactionConfig>): void {
  const updateBudget = (_event: unknown, ctx: { model?: { contextWindow?: number; maxTokens?: number } }): void => {
    if (!ctx.model) return;
    const budget = resolveCompactionBudget(ctx.model, config);
    settingsManager.applyOverrides({ compaction: { enabled: budget.enabled, reserveTokens: budget.reserveTokens, keepRecentTokens: budget.keepRecentTokens } });
  };
  pi.on("session_start", updateBudget);
  pi.on("model_select", updateBudget);
}

export interface ContextCompactionConfig {
  /** 是否启用自动压缩与上下文溢出恢复。 */
  enabled: boolean;
  /** 达到窗口的这个比例后开始压缩（laozhou: 0.8）。 */
  trimAtRatio?: number;
  /** 一次机械裁剪释放的窗口比例（laozhou: 0.15）。 */
  trimBatchRatio?: number;
  /** 响应/摘要预留的窗口比例（laozhou: 0.1）。 */
  reservedRatio?: number;
  /** 响应预留 token 的最小值（laozhou: 4096）。 */
  minReservedTokens?: number;
  /** 压缩后逐字保留的最近 token 数（laozhou: 16384）。 */
  compactTailTokens?: number;

  /** @deprecated 旧版 DeepSeek Harness 配置，读取时映射到 laozhou 参数。 */
  thresholdRatio?: number;
  /** @deprecated 旧版配置，已不再按窗口比例保留尾部。 */
  retainRatio?: number;
  /** @deprecated 旧版配置，laozhou 不使用额外 headroom。 */
  headroomTokens?: number;
}

export const DEFAULT_CONTEXT_COMPACTION: ContextCompactionConfig = {
  enabled: true,
  trimAtRatio: 0.8,
  trimBatchRatio: 0.15,
  reservedRatio: 0.1,
  minReservedTokens: 4_096,
  compactTailTokens: 16_384,
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
 * 按 laozhou 的窗口策略计算 pi 所需的压缩预算。
 *
 * 旧版配置仍可被读取：thresholdRatio 作为 trimAtRatio；retainRatio 和
 * headroomTokens 不再参与计算，避免不同模型因最大输出大小而提前压缩。
 */
export function resolveCompactionBudget(
  model: { contextWindow?: number; maxTokens?: number },
  config?: Partial<ContextCompactionConfig> | null,
): CompactionBudget {
  const settings = config && typeof config === "object" ? config : {};
  const window = resolveContextWindow(model.contextWindow);
  if (!Number.isFinite(window)) {
    // Infinity prevents threshold-based compaction while enabled still allows
    // pi to recover from an actual context-overflow error returned by the API.
    return {
      enabled: settings.enabled !== false,
      reserveTokens: Math.max(1, Math.floor(finiteNumber(settings.minReservedTokens, DEFAULT_CONTEXT_COMPACTION.minReservedTokens!))),
      keepRecentTokens: Math.max(1, Math.floor(finiteNumber(settings.compactTailTokens, DEFAULT_CONTEXT_COMPACTION.compactTailTokens!))),
      thresholdTokens: Number.POSITIVE_INFINITY,
    };
  }
  const trimAtRatio = clamp(
    finiteNumber(settings.trimAtRatio, finiteNumber(settings.thresholdRatio, DEFAULT_CONTEXT_COMPACTION.trimAtRatio ?? 0.8)),
    0.1,
    1,
  );
  const reservedRatio = clamp(
    finiteNumber(settings.reservedRatio, DEFAULT_CONTEXT_COMPACTION.reservedRatio ?? 0.1),
    0,
    0.9,
  );
  const minReservedTokens = Math.max(
    1,
    Math.floor(finiteNumber(settings.minReservedTokens, DEFAULT_CONTEXT_COMPACTION.minReservedTokens ?? 4_096)),
  );
  const reservedTokens = Math.max(minReservedTokens, Math.floor(window * reservedRatio));
  const thresholdTokens = Math.max(1, Math.floor(window * trimAtRatio));

  // pi uses reserveTokens both as the trigger gap and as the summary output
  // budget. Keep the laozhou 80% trigger exact by default while enforcing its
  // minimum response reserve for custom watermarks; model.maxTokens limits the
  // actual request independently inside pi.
  const reserveTokens = Math.max(1, window - thresholdTokens, reservedTokens);
  const requestedTail = Math.floor(
    finiteNumber(settings.compactTailTokens, DEFAULT_CONTEXT_COMPACTION.compactTailTokens ?? 16_384),
  );
  const maxTailTokens = Math.max(1, Math.min(Math.floor(window / 2), window - reservedTokens));
  const keepRecentTokens = Math.max(1, Math.min(maxTailTokens, requestedTail));

  return {
    enabled: settings.enabled === undefined ? DEFAULT_CONTEXT_COMPACTION.enabled : settings.enabled === true,
    reserveTokens,
    keepRecentTokens,
    thresholdTokens,
  };
}
