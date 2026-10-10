export function catalogPage(raw: string | null, total: number, pageSize: number) {
  const parsed = Number(raw ?? "1");
  const page = Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

export function quotaPercentage(current: number, maximum: number) {
  return maximum <= 0 ? 100 : Math.max(0, Math.min(100, Math.round(current / maximum * 100)));
}
