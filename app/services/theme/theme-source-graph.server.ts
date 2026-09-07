import { createHash } from "node:crypto";
import { getThemeFiles, type ThemeFile } from "./theme-reader.server";
import { parseShopifyThemeJson } from "./theme-json.server";

export type SearchThemeMap = {
  version: 3;
  template: string;
  sectionIds: string[];
  sectionFiles: string[];
  files: string[];
  dependencies: Record<string, string[]>;
  missing: string[];
  unsupported: string[];
  fingerprint: string;
};

// Static references only. Dynamic references cannot be reconstructed safely
// outside the original section scope and are reported, never guessed.
export function liquidDependencies(content: string) {
  const source = content.replace(/{%-?\s*(comment|raw|schema|javascript|stylesheet)\b[\s\S]*?{%-?\s*end\1\s*-?%}/g, "");
  const dependencies = new Set<string>();
  const unsupported = new Set<string>();
  for (const tag of source.matchAll(/{%-?([\s\S]*?)-?%}/g)) {
    const statements = tag[1].trim().replace(/^liquid\s+/, "").split(/\r?\n/);
    for (const statement of statements) {
      const text = statement.trim();
      const invocation = text.match(/^(render|include|section)\s+(['"])([^'"]+)\2/);
      if (invocation) {
        const name = invocation[3];
        if (!/^[\w/-]+$/.test(name) || name.includes("..")) {
          unsupported.add("invalid static dependency");
          continue;
        }
        dependencies.add(`${invocation[1] === "section" ? "sections" : "snippets"}/${name}.liquid`);
      } else if (/^(render|include|section)\b/.test(text)) {
        unsupported.add("dynamic Liquid dependency");
      }
      if (/^content_for\b/.test(text)) {
        unsupported.add("theme block rendering requires native section context");
        const block = text.match(/\btype:\s*(['"])([\w-]+)\1/);
        if (block) dependencies.add(`blocks/${block[2]}.liquid`);
      }
    }
  }
  return { dependencies: [...dependencies], unsupported: [...unsupported] };
}

export function searchMapFingerprint(files: Map<string, ThemeFile>, names: string[]) {
  const hash = createHash("sha256");
  for (const name of [...new Set(names)].sort()) {
    // Hash content, including an absence marker: an added JSON template must
    // invalidate a previously selected Liquid template even without a webhook.
    hash.update(JSON.stringify([name, files.get(name)?.content ?? null]));
  }
  return hash.digest("hex");
}

export function buildSearchThemeMap(files: Map<string, ThemeFile>): SearchThemeMap {
  const template = files.has("templates/search.json") ? "templates/search.json" : "templates/search.liquid";
  if (!files.has(template)) throw new Error("SEARCH_TEMPLATE_NOT_FOUND");
  const sectionIds: string[] = [];
  const sectionFiles: string[] = [];
  const dependencies: Record<string, string[]> = {};
  const unsupported: string[] = [];
  const pending = [template];
  if (template.endsWith(".json")) {
    const parsed = parseShopifyThemeJson<{
      sections?: Record<string, { type?: string; disabled?: boolean; blocks?: unknown }>;
      order?: string[];
    }>(files.get(template)!.content);
    if (!parsed.sections || !Array.isArray(parsed.order)) throw new Error("INVALID_SEARCH_TEMPLATE_STRUCTURE");
    for (const id of parsed.order) {
      const section = parsed.sections[id];
      if (!section) throw new Error("SEARCH_TEMPLATE_SECTION_MISSING");
      if (section.disabled) continue;
      if (!section.type || !/^[\w-]+$/.test(section.type)) throw new Error("INVALID_SEARCH_SECTION_TYPE");
      sectionIds.push(id);
      sectionFiles.push(`sections/${section.type}.liquid`);
    }
    dependencies[template] = [...new Set(sectionFiles)];
    pending.push(...sectionFiles);
  }
  const visited = new Set<string>();
  const missing: string[] = [];
  while (pending.length) {
    const filename = pending.shift()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const file = files.get(filename);
    if (!file) { missing.push(filename); continue; }
    if (!filename.endsWith(".liquid")) continue;
    const refs = liquidDependencies(file.content);
    if (filename === template) {
      for (const name of refs.dependencies.filter((dependency) => dependency.startsWith("sections/"))) {
        sectionFiles.push(name);
        sectionIds.push(name.slice(9, -7));
      }
    }
    dependencies[filename] = refs.dependencies;
    unsupported.push(...refs.unsupported.map((reason) => `${filename}: ${reason}`));
    pending.push(...refs.dependencies);
  }
  const names = [...visited].sort();
  const probes = [...names, "templates/search.json", "templates/search.liquid", "config/settings_data.json"];
  return { version: 3, template, sectionIds, sectionFiles, files: names, dependencies,
    missing, unsupported, fingerprint: searchMapFingerprint(files, probes) };
}

export function searchMapProbeFiles(map: SearchThemeMap) {
  return [...new Set([...map.files, "templates/search.json", "templates/search.liquid", "config/settings_data.json"])];
}

export async function isSearchThemeMapCurrent(admin: Parameters<typeof getThemeFiles>[0], themeId: string, map: SearchThemeMap) {
  const probes = searchMapProbeFiles(map);
  const fresh = new Map<string, ThemeFile>();
  for (let offset = 0; offset < probes.length; offset += 50) {
    const batch = await getThemeFiles(admin, themeId, probes.slice(offset, offset + 50));
    for (const [name, file] of batch) fresh.set(name, file);
  }
  return map.fingerprint === searchMapFingerprint(fresh, probes);
}

export async function readSearchThemeFiles(
  admin: Parameters<typeof getThemeFiles>[0], themeId: string,
) {
  const files = await getThemeFiles(admin, themeId, ["templates/search.json", "templates/search.liquid", "config/settings_data.json"]);
  // Follow only dependencies reachable from the default search template.
  // Batch API requests within Shopify's filename limit, with a bounded graph.
  for (let depth = 0; depth < 50; depth += 1) {
    const map = buildSearchThemeMap(files);
    if (!map.missing.length) return files;
    if (files.size + map.missing.length > 1000) throw new Error("SEARCH_DEPENDENCY_LIMIT_EXCEEDED");
    for (let offset = 0; offset < map.missing.length; offset += 50) {
      const names = map.missing.slice(offset, offset + 50);
      const batch = await getThemeFiles(admin, themeId, names);
      if (names.some((name) => !batch.has(name))) throw new Error(`SEARCH_DEPENDENCIES_MISSING: ${names.filter((name) => !batch.has(name)).join(", ")}`);
      for (const [name, file] of batch) files.set(name, file);
    }
  }
  throw new Error("SEARCH_DEPENDENCY_DEPTH_EXCEEDED");
}
