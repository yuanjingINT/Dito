/** 长记忆策略；默认值参考 laozhou 的日记整理、联想与遗忘机制。 */
export interface MemoryConfig {
  enabled: boolean;
  autoDiary: boolean;
  associationEnabled: boolean;
  autoFact: boolean;
  diaryBatchSize: number;
  shortDiaryRetentionDays: number;
  diaryPromotionRecalls: number;
  organizerTimeoutSeconds: number;
  associationFacts: number;
  associationEpisodes: number;
  associationMaxChars: number;
  forgettingEnabled: boolean;
  forgettingHalfLifeDays: number;
  forgettingMinStrength: number;
  forgettingReviewBoost: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true, autoDiary: true, associationEnabled: true, autoFact: true,
  diaryBatchSize: 14, shortDiaryRetentionDays: 14, diaryPromotionRecalls: 3,
  organizerTimeoutSeconds: 120, associationFacts: 5, associationEpisodes: 3,
  associationMaxChars: 1800, forgettingEnabled: true, forgettingHalfLifeDays: 7,
  forgettingMinStrength: 0.15, forgettingReviewBoost: 0.35,
};

export function resolveMemoryConfig(raw?: Partial<MemoryConfig> | null): MemoryConfig {
  const result = { ...DEFAULT_MEMORY_CONFIG };
  for (const key of Object.keys(result) as (keyof MemoryConfig)[]) {
    const value = raw?.[key];
    if (typeof result[key] === "boolean") {
      if (typeof value === "boolean") (result as any)[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      const range: Record<string, [number, number]> = {
        diaryBatchSize: [1, 50], shortDiaryRetentionDays: [1, 365], diaryPromotionRecalls: [1, 100],
        organizerTimeoutSeconds: [1, 300], associationFacts: [0, 20], associationEpisodes: [0, 20],
        associationMaxChars: [200, 10000], forgettingHalfLifeDays: [0.1, 3650],
        forgettingMinStrength: [0, 1], forgettingReviewBoost: [0, 1],
      };
      const [min, max] = range[key];
      const bounded = Math.max(min, Math.min(max, value));
      (result as any)[key] = key.startsWith("forgetting") ? bounded : Math.floor(bounded);
    }
  }
  return result;
}
