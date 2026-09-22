ALTER TABLE "AiSearchQueryLog" ADD COLUMN "analyzedQuery" TEXT;
ALTER TABLE "AiSearchQueryLog" ADD COLUMN "llmAnalysisJson" TEXT;
ALTER TABLE "AiSearchQueryLog" ADD COLUMN "selectedContextJson" TEXT;
