export type AiSearchProcessRole = "all" | "web" | "worker";

export function getAiSearchProcessRole(): AiSearchProcessRole {
  const value = process.env.AI_SEARCH_PROCESS_ROLE?.trim().toLowerCase();
  if (value === "web" || value === "worker") return value;
  return "all";
}

export function backgroundJobsEnabledInThisProcess() {
  const enabled = process.env.AI_SEARCH_BACKGROUND_WORKERS_ENABLED
    ?.trim()
    .toLowerCase();
  if (enabled && ["0", "false", "off", "no"].includes(enabled)) {
    return false;
  }
  return getAiSearchProcessRole() !== "web";
}

export function jitterInterval(baseMs: number, ratio = 0.15) {
  const safeBase = Math.max(1_000, Math.trunc(baseMs));
  const safeRatio = Math.max(0, Math.min(ratio, 0.4));
  const factor = 1 - safeRatio + Math.random() * safeRatio * 2;
  return Math.max(1_000, Math.round(safeBase * factor));
}
