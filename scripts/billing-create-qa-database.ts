import db from "../app/db.server";
if(process.env.NODE_ENV === "production") throw new Error("Local QA only");
try { await db.$executeRawUnsafe("CREATE DATABASE IF NOT EXISTS ai_search_billing_qa_20261009"); console.log("Isolated billing QA database ready"); }
finally { await db.$disconnect(); }
