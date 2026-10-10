export function modelCostMicros(provider: string, model: string, input: number, cached: number, output: number) {
  // Explicit model identity, no silently inherited rate from another model.
  let rates: unknown;
  try { rates = JSON.parse(process.env.AI_SEARCH_MODEL_COST_RATES_JSON ?? "{}"); } catch { return null; }
  const rate = (rates as Record<string, { input?: number; cachedInput?: number; output?: number }> | null)?.[`${provider}:${model}`];
  if (!rate || ![rate.input, rate.cachedInput, rate.output].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  const cachedCount = Math.min(input, cached);
  // USD per million tokens equals micro-USD per token.
  const cost = Math.round((input - cachedCount) * rate.input! + cachedCount * rate.cachedInput! + output * rate.output!);
  return Number.isSafeInteger(cost) && cost >= 0 && cost <= 2147483647 ? cost : null;
}
