/** Admin exposes period end, not invoice payment or exact period start.
 * This start is a ledger boundary derived from the recurring interval. */
export function deriveBillingPeriodStart(createdAt: Date | null, end: Date | null, interval: string | null, previousStart: Date | null) {
  if (!end || !["EVERY_30_DAYS", "ANNUAL"].includes(interval ?? "")) return previousStart ?? createdAt;
  const days = interval === "ANNUAL" ? 365 : 30;
  const derived = new Date(end.getTime() - days * 86400000);
  return createdAt && createdAt > derived ? createdAt : derived;
}
