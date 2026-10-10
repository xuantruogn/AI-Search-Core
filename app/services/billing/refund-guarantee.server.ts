import db from "../../db.server";
import { checkoutBillingPolicy, refundGuaranteeWindow } from "./plan-policy";

export async function listRefundGuarantees(shop: string) {
  const charges = await db.billingCharge.findMany({
    where: { shop, status: "PAID", paidAt: { not: null }, shopifyChargeId: { not: null }, testMode: false },
    orderBy: { paidAt: "desc" }, take: 10,
    include: { subscription: true, refunds: true },
  });
  const requests = charges.length ? await db.billingEvent.findMany({
    where: { shop, type: "REFUND_REQUESTED", idempotencyKey: { in: charges.map((charge) => `guarantee-request:${charge.id}`) } },
    select: { idempotencyKey: true },
  }) : [];
  const requestedKeys = new Set(requests.map((request) => request.idempotencyKey));
  return charges.map((charge) => {
    const policy = checkoutBillingPolicy(charge.subscription?.rawResponse);
    const window = refundGuaranteeWindow(policy, charge);
    const request = requestedKeys.has(`guarantee-request:${charge.id}`);
    return {
      chargeId: charge.id, amount: charge.amount?.toString() ?? null, currency: charge.currency,
      paidAt: charge.paidAt!.toISOString(), policy, endsAt: window.endsAt,
      eligible: window.eligible && charge.refunds.length === 0 && !request,
      reason: charge.refunds.length ? "REFUND_ALREADY_RECORDED" : request ? "REQUESTED" : window.reason,
    };
  });
}

export async function requestGuaranteedRefund(shop: string, chargeId: string, reason: string) {
  const message = reason.trim().slice(0, 2000);
  if (message.length < 3) throw new Error("Please describe why you are requesting a refund.");
  return db.$transaction(async (tx) => {
    const charge = await tx.billingCharge.findFirst({
      where: { id: chargeId, shop }, include: { subscription: true, refunds: true },
    });
    if (!charge) throw new Error("Charge not found for this store.");
    const key = `guarantee-request:${charge.id}`;
    const existing = await tx.billingEvent.findUnique({ where: { idempotencyKey: key } });
    if (existing) return existing;
    const policy = checkoutBillingPolicy(charge.subscription?.rawResponse);
    const window = refundGuaranteeWindow(policy, charge);
    if (!window.eligible || charge.refunds.length) throw new Error("This charge is not eligible for a new money-back guarantee request. Contact support for review.");
    // REQUESTED is an audit/work item, not evidence of a refund. Never change
    // paid status, access, subscription or vectors just because it was requested.
    return tx.billingEvent.upsert({
      where: { idempotencyKey: key }, update: {},
      create: {
        shop, subscriptionGid: charge.subscriptionGid, type: "REFUND_REQUESTED", source: "API",
        idempotencyKey: key, occurredAt: new Date(),
        payload: { kind: "MONEY_BACK_GUARANTEE_REQUEST", chargeId, reason: message, policy, guaranteeEndsAt: window.endsAt, processing: "MANUAL_PROVIDER_REVIEW" },
      },
    });
  });
}
