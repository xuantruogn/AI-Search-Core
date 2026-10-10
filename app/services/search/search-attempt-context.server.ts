import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import db from "../../db.server";

type Attempt = {
  id: string; startedAt: number; shop?: string; purpose?: string; queryHash?: string;
  aiExecuted: boolean; cacheHit: boolean; nativeFallback: boolean;
  resultCount?: number; searchLogId?: string; reservationId?: string; periodId?: number;
  failureKind?: string; reason?: string;
};
const context = new AsyncLocalStorage<Attempt>();
export const currentSearchAttempt = (shop?: string) => { const value = context.getStore(); return shop && value?.shop !== shop ? undefined : value; };
export function patchSearchAttempt(patch: Partial<Attempt>) { const current = context.getStore(); if (current) Object.assign(current, patch); }
export function attemptFailure(error: unknown, phase?: string) {
  const name = error instanceof Error ? error.name : "";
  const kind = /Timeout|Abort/i.test(name) ? "TIMEOUT" : phase === "rewrite" ? "AI_PROVIDER_ERROR" : phase === "semanticSearch" ? "RETRIEVAL_ERROR" : "PIPELINE_ERROR";
  patchSearchAttempt({ failureKind: kind });
}
export async function beginSearchAttempt(shop: string, purpose: string, query: string) {
  const current = context.getStore(); if (!current) return;
  Object.assign(current, { shop, purpose, queryHash: createHash("sha256").update(query).digest("hex") });
  try { await db.aiSearchAttempt.create({ data: { id: current.id, shop, purpose, queryHash: current.queryHash! } }); }
  catch { console.error("[Search Attempt] START_WRITE_FAILED", { attemptId: current.id }); }
}
export function attemptStatus(attempt: Pick<Attempt, "purpose" | "failureKind" | "reason" | "nativeFallback" | "cacheHit" | "resultCount">) {
  if (attempt.reason === "SEARCH_QUOTA_EXCEEDED") return "QUOTA_BLOCKED";
  if (attempt.failureKind) return attempt.failureKind;
  if (attempt.nativeFallback) return "NATIVE_FALLBACK";
  if (attempt.resultCount === 0) return "ZERO_RESULTS";
  if (attempt.cacheHit) return "CACHE_HIT";
  return attempt.purpose === "SEARCH" ? "SUCCESS" : "PROXY_RESPONSE";
}
export async function withSearchAttempt(run: () => Promise<Response>) {
  const attempt: Attempt = { id: `att_${randomUUID()}`, startedAt: Date.now(), aiExecuted: false, cacheHit: false, nativeFallback: false };
  return context.run(attempt, async () => {
    let response: Response | undefined;
    try { response = await run(); try { response.headers.set("X-AI-Search-Attempt-ID", attempt.id); } catch { /* Immutable response headers must not break search. */ } return response; }
    catch (error) { if (error instanceof Response) { response = error; } else attemptFailure(error); throw error; }
    finally {
      if (attempt.shop && attempt.purpose && attempt.queryHash) {
        if (!attempt.failureKind && response && response.status >= 500) attempt.failureKind = "PIPELINE_ERROR";
        const record = { id: attempt.id, shop: attempt.shop, purpose: attempt.purpose, queryHash: attempt.queryHash, status: attemptStatus(attempt), failureKind: attempt.failureKind ?? null, reason: attempt.reason?.slice(0, 191) ?? null, aiExecuted: attempt.aiExecuted, cacheHit: attempt.cacheHit, nativeFallback: attempt.nativeFallback, resultCount: attempt.resultCount ?? null, searchLogId: attempt.searchLogId ?? null, reservationId: attempt.reservationId ?? null, periodId: attempt.periodId ?? null, durationMs: Date.now() - attempt.startedAt, httpStatus: response?.status ?? null, finishedAt: new Date() };
        try { await db.aiSearchAttempt.upsert({ where: { id: attempt.id }, create: record, update: record }); }
        catch { console.error("[Search Attempt] FINISH_WRITE_FAILED", { attemptId: attempt.id }); }
      }
    }
  });
}
