export type ReadinessCheck = "PASS" | "DEGRADED" | "UNKNOWN" | "DISABLED";
export function workerCheck(disabled: boolean, leaseUntil: Date | undefined, now: Date): ReadinessCheck {
  if (disabled) return "DISABLED";
  if (!leaseUntil) return "UNKNOWN";
  return leaseUntil > now ? "PASS" : "DEGRADED";
}
export function readinessState(checks: ReadinessCheck[]) {
  if (checks.some((value) => value === "DEGRADED" || value === "DISABLED")) return "NOT_READY";
  if (checks.some((value) => value === "UNKNOWN")) return "UNKNOWN";
  return "READY";
}
export function positiveMs(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
