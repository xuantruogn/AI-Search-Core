import db from "../app/db.server";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV === "production") throw new Error("Local repair only; review and explicitly approve production repair separately.");
try {
  const rows = await db.billingCharge.findMany({where:{status:"PAID",shopifyChargeId:null},select:{id:true,shop:true,subscriptionGid:true,paidAt:true,rawResponse:true}});
  const inferred = rows.filter(row => {
    const raw = row.rawResponse as Record<string,unknown> | null;
    return raw?.status === "ACTIVE" && raw.subscriptionGid === row.subscriptionGid;
  });
  console.log("Unverified legacy inferred payments",{count:inferred.length,apply:process.argv.includes("--apply")});
  if (process.argv.includes("--apply")) {
    for (const row of inferred) await db.$transaction(async tx=>{
      const key = `payment-evidence-repair:${row.id}`;
      if(await tx.billingEvent.findUnique({where:{idempotencyKey:key}})) return;
      await tx.billingEvent.create({data:{id:randomUUID(),shop:row.shop,subscriptionGid:row.subscriptionGid,type:"BILLING_RECONCILED",source:"RECONCILIATION",idempotencyKey:key,occurredAt:new Date(),payload:{reason:"ACTIVE_IS_NOT_PAYMENT_EVIDENCE",previousStatus:"PAID",previousPaidAt:row.paidAt?.toISOString()??null}}});
      await tx.billingCharge.updateMany({where:{id:row.id,shopifyChargeId:null,status:"PAID"},data:{status:"PENDING",paidAt:null}});
      if(row.subscriptionGid) {
        const verified = await tx.billingCharge.count({where:{subscriptionGid:row.subscriptionGid,status:"PAID",shopifyChargeId:{not:null},paidAt:{not:null}}});
        if(!verified) await tx.billingSubscription.updateMany({where:{shopifySubscriptionGid:row.subscriptionGid,paymentStatus:{in:["PAID","RECOVERED"]}},data:{paymentStatus:"PENDING",chargeStatus:"PENDING"}});
      }
    });
  }
} finally {await db.$disconnect();}
