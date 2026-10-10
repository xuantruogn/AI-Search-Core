import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readFile, opendir } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import db from "../../db.server";

type Event = Prisma.AiSearchApiUsageEventUncheckedCreateInput;
const directory = () => path.resolve(process.env.AI_SEARCH_TELEMETRY_OUTBOX_DIR || ".data/telemetry-outbox");
export function telemetryKey(provider: string, operation: string, requestId: string) {
  return createHash("sha256").update(JSON.stringify([provider, operation, requestId])).digest("hex");
}
async function persist(event: Event) {
  const key = event.idempotencyKey;
  if (!key) throw new Error("Telemetry requires idempotency key");
  const observedAt = new Date(event.createdAt ?? Date.now());
  // Tombstones survive raw-event compaction. Stale envelopes are not counted
  // again. Housekeeping may remove expired receipts; reject stale envelopes
  // before insertion so replay after expiry cannot count the cost twice.
  const expiresAt = new Date(observedAt.getTime() + 180 * 86400000);
  if (!Number.isFinite(observedAt.getTime()) || expiresAt <= new Date()) throw new Error("STALE_TELEMETRY_ENVELOPE");
  await db.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT IGNORE INTO AiSearchTelemetryReceipt (\`key\`, expiresAt) VALUES (${key}, ${expiresAt})
    `;
    if (!inserted) return;
    await tx.aiSearchApiUsageEvent.upsert({ where: { idempotencyKey: key }, create: event, update: {} });
  });
}

// Await only the local durable write. DB retry is independent of customer AI success.
export async function enqueueTelemetry(event: Event, write: (event: Event) => Promise<unknown> = persist) {
  event = { createdAt: new Date().toISOString(), ...event };
  const dir = directory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `${randomUUID()}.tmp`);
  const target = path.join(dir, `${event.idempotencyKey}.json`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(event)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
  void write(event).then(() => unlink(target)).catch(() => { /* Durable file remains for replay. */ });
  if (write === persist) startTelemetryReplay();
}

const runtime = globalThis as typeof globalThis & { aiTelemetryReplayStarted?: boolean; aiTelemetryReplayRunning?: boolean };
export async function replayTelemetry(write: (event: Event) => Promise<unknown> = persist) {
  if (runtime.aiTelemetryReplayRunning) return;
  runtime.aiTelemetryReplayRunning = true;
  try {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const entries = await opendir(directory());
    let processed = 0;
    for await (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const filename = path.join(directory(), entry.name);
      try {
        const event = JSON.parse(await readFile(filename, "utf8")) as Event;
        if (`${event.idempotencyKey}.json` !== entry.name) throw new Error("Invalid telemetry envelope");
        await write(event);
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
      }
      if (++processed >= 100) break;
    }
  } finally { runtime.aiTelemetryReplayRunning = false; }
}
export function startTelemetryReplay() {
  if (runtime.aiTelemetryReplayStarted) return;
  runtime.aiTelemetryReplayStarted = true;
  const run = () => void replayTelemetry().catch(() => console.error("[Telemetry] Outbox replay unavailable"));
  run();
  const timer = setInterval(run, 30000); timer.unref?.();
}
