import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  compileThemeMapV4,
  type CompileThemeBlockInstance,
} from "../app/services/theme/theme-map-v4.compiler.server";
import { parseShopifyThemeJson } from "../app/services/theme/theme-json.server";
import { buildThemeResultLiquid } from "../app/services/renderer/theme-result-renderer.server";

type CorpusFile = { path: string; sha256: string };
type CorpusSnapshot = {
  snapshot_id: string;
  theme: string;
  search_corpus_sha256: string;
  search_template_info: Record<string, { parsed: boolean; section_types: string[] }>;
  relevant_files: CorpusFile[];
};
type Corpus = {
  snapshots: CorpusSnapshot[];
  file_blobs: Record<string, { content: string }>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function blocksFrom(value: unknown): CompileThemeBlockInstance[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const block = raw as { type?: unknown; blocks?: unknown; disabled?: unknown };
    if (block.disabled === true || typeof block.type !== "string") return [];
    return [{ id, type: block.type, blocks: blocksFrom(block.blocks) }];
  });
}

function main() {
  const corpusPath = process.argv[2] || process.env.AI_SEARCH_THEME_CORPUS_PATH;
  assert.ok(corpusPath, "Pass the corpus JSON path as argv[2] or AI_SEARCH_THEME_CORPUS_PATH");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
  const report: Array<Record<string, unknown>> = [];
  const failures: Array<{
    snapshot: string;
    theme: string;
    family: string;
    reasons: string[];
    candidates: unknown[];
  }> = [];

  for (const snapshot of corpus.snapshots) {
    const files = snapshot.relevant_files.map((file) => {
      const content = corpus.file_blobs[file.sha256]?.content;
      assert.equal(typeof content, "string", `${snapshot.snapshot_id}: missing blob ${file.sha256}`);
      return { filename: file.path, content, checksum: file.sha256 || sha256(content) };
    });
    const templateFile = Object.keys(snapshot.search_template_info)[0];
    assert.ok(templateFile, `${snapshot.snapshot_id}: search template missing`);
    const template = files.find((file) => file.filename === templateFile);
    assert.ok(template, `${snapshot.snapshot_id}: template blob missing`);
    const parsed = parseShopifyThemeJson<{
      sections?: Record<string, { type?: string; disabled?: boolean; blocks?: unknown }>;
    }>(template.content);
    const enabledSections = Object.entries(parsed.sections ?? {}).filter(
      ([, section]) => section.disabled !== true && typeof section.type === "string",
    );
    const sectionSources = enabledSections.flatMap(([sectionKey, section]) => {
      const sectionType = section.type as string;
      const file = files.find((candidate) =>
        candidate.filename === `sections/${sectionType}.liquid`,
      );
      if (!file || !file.content.includes("search.results")) return [];
      const productFlowScore = [
        /for\s+\w+\s+in\s+search\.results/,
        /search\.results\s*\|\s*where:\s*['"]object_type['"]\s*,\s*['"]product['"]/,
        /when\s+['"]product['"]/,
        /closest\.product\s*:/,
        /render\s+['"][^'"]+['"][\s\S]{0,300}(?:product|item|resource)\s*:/,
      ].reduce((score, pattern) => score + (pattern.test(file.content) ? 1 : 0), 0);
      return [{ sectionKey, section, sectionType, file, productFlowScore }];
    }).sort((left, right) => right.productFlowScore - left.productFlowScore);
    const selectedSection = sectionSources[0];
    assert.ok(selectedSection, `${snapshot.snapshot_id}: no referenced search-results section`);
    assert.ok(
      selectedSection.productFlowScore > 0,
      `${snapshot.snapshot_id}: referenced section has no proven product data-flow`,
    );
    const source = selectedSection.file;
    const sectionType = selectedSection.sectionType;
    const sectionEntry = [selectedSection.sectionKey, selectedSection.section] as const;
    const [sectionKey, section] = sectionEntry;
    const family = source.filename.endsWith("/search-results.liquid")
      ? "BLOCK_RESULTS_LIST"
      : "CLASSIC_MAIN_SEARCH";
    const map = compileThemeMapV4({
      theme: { id: snapshot.snapshot_id, name: snapshot.theme },
      search: {
        templateFile,
        templateType: templateFile.endsWith(".json") ? "JSON" : "LIQUID",
        sectionKey,
        sectionType,
        sectionFile: source.filename,
      },
      sourceFile: source.filename,
      source: source.content,
      files,
      themeBlocks: blocksFrom(section.blocks),
      settingResolver: {
        resolveSectionSetting(expression) {
          const name = expression.match(/^section\.settings\.([A-Za-z_][A-Za-z0-9_-]*)$/)?.[1];
          if (!name) return undefined;
          const settings = (section as { settings?: Record<string, unknown> }).settings ?? {};
          const value = settings[name];
          return typeof value === "string" || typeof value === "number" ||
            typeof value === "boolean" || value === null ? value : undefined;
        },
      },
    });
    const contextCandidate = map.rendererCandidates.find((candidate) =>
      candidate.renderStrategy === "THEME_CONTEXT_REQUIRED",
    );
    const classicValid = map.status === "VERIFIED" &&
      map.rendererCandidates.some((candidate) => candidate.status === "ELIGIBLE");
    const blockValid = Boolean(contextCandidate?.mount);
    const valid = family === "CLASSIC_MAIN_SEARCH" ? classicValid : blockValid;
    if (snapshot.theme.toLowerCase() === "ride" && classicValid) {
      const ridePlan = buildThemeResultLiquid({
        map,
        products: [
          { productId: "gid://shopify/Product/1", handle: "women-jacket" },
          { productId: "gid://shopify/Product/2", handle: "winter-jacket" },
        ],
      });
      assert.doesNotMatch(ridePlan.liquid, /ai_product\.object_type/);
      assert.doesNotMatch(ridePlan.liquid, /item\.object_type/);
      assert.match(ridePlan.liquid, /render\s+'card-product'/);
      assert.match(ridePlan.liquid, /card_product:\s*ai_product/);
      assert.ok(
        ridePlan.liquid.indexOf("women-jacket") < ridePlan.liquid.indexOf("winter-jacket"),
        `${snapshot.snapshot_id}: ranked handle order changed`,
      );
    }
    if (!valid) {
      failures.push({
        snapshot: snapshot.snapshot_id,
        theme: snapshot.theme,
        family,
        reasons: map.unsupportedReason ? [map.unsupportedReason] : [],
        candidates: map.rendererCandidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          sourceFile: candidate.sourceFile,
          snippet: candidate.snippet ?? null,
          binding: candidate.productBinding,
          strategy: candidate.renderStrategy,
          contextClass: candidate.contextClass,
          status: candidate.status,
          mount: candidate.mount ?? null,
          dependencies: candidate.dependencies,
          rejectionReasons: candidate.rejectionReasons,
        })),
      });
    }
    report.push({
      theme: snapshot.theme,
      snapshot: snapshot.snapshot_id,
      corpus: snapshot.search_corpus_sha256,
      family,
      status: map.status,
      candidates: map.rendererCandidates.length,
      eligible: map.rendererCandidates.filter((candidate) => candidate.status === "ELIGIBLE").length,
      selected: map.rendererCandidates[0]?.id ?? null,
      strategy: map.rendererCandidates[0]?.renderStrategy ?? null,
      mount: map.rendererCandidates[0]?.mount?.selector ?? null,
      rejectionReasons: map.rendererCandidates[0]?.rejectionReasons ?? [],
    });
  }

  console.table(report);
  if (failures.length > 0) {
    console.error("Theme Map V4 corpus failures:");
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log("Theme Map V4 corpus self-test: PASS", {
    snapshots: report.length,
    uniqueCorpora: new Set(report.map((item) => item.corpus)).size,
  });
}

main();
