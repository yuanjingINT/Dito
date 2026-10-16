const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  autoDiary: true,
  associationEnabled: true,
  autoFact: true,
  diaryBatchSize: 14,
  shortDiaryRetentionDays: 14,
  diaryPromotionRecalls: 3,
  organizerTimeoutSeconds: 120,
  associationFacts: 5,
  associationEpisodes: 3,
  associationMaxChars: 1800,
  forgettingEnabled: true,
  forgettingHalfLifeDays: 7,
  forgettingMinStrength: 0.15,
  forgettingReviewBoost: 0.35
};
function resolveMemoryConfig(raw) {
  const result = { ...DEFAULT_MEMORY_CONFIG };
  for (const key of Object.keys(result)) {
    const value = raw?.[key];
    if (typeof result[key] === "boolean") {
      if (typeof value === "boolean") result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      const range = {
        diaryBatchSize: [1, 50],
        shortDiaryRetentionDays: [1, 365],
        diaryPromotionRecalls: [1, 100],
        organizerTimeoutSeconds: [1, 300],
        associationFacts: [0, 20],
        associationEpisodes: [0, 20],
        associationMaxChars: [200, 1e4],
        forgettingHalfLifeDays: [0.1, 3650],
        forgettingMinStrength: [0, 1],
        forgettingReviewBoost: [0, 1]
      };
      const [min, max] = range[key];
      const bounded = Math.max(min, Math.min(max, value));
      result[key] = key.startsWith("forgetting") ? bounded : Math.floor(bounded);
    }
  }
  return result;
}
export {
  DEFAULT_MEMORY_CONFIG,
  resolveMemoryConfig
};
