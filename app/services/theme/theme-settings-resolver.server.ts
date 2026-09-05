export type ThemeSectionSettings = Record<
  string,
  string | number | boolean | null
>;

type SearchTemplateSection = {
  type?: string;
  settings?: ThemeSectionSettings;
};

type SearchTemplate = {
  sections?: Record<string, SearchTemplateSection>;
  order?: string[];
};

function sanitizeSettings(
  value: Record<string, unknown> | null | undefined,
): ThemeSectionSettings {
  const safe: ThemeSectionSettings = {};

  for (const [key, setting] of Object.entries(value ?? {})) {
    if (
      setting === null ||
      typeof setting === "string" ||
      typeof setting === "number" ||
      typeof setting === "boolean"
    ) {
      safe[key] = setting;
    }
  }

  return safe;
}

export function stripJsonComments(content: string): string {
  // Shopify JSON templates/settings are normally strict JSON, but customized
  // themes occasionally contain block comments. Remove comments only while
  // outside JSON strings so values such as URLs or merchant text containing
  // `/* ... */` are never corrupted.
  let output = "";
  let inString = false;
  let escaped = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output.trim();
}

export function parseShopifyThemeJson<T>(content: string): T {
  return JSON.parse(stripJsonComments(content)) as T;
}

export function findTemplateSectionSettings(
  content: string,
  preferredSectionTypes: string[],
): { found: boolean; settings: ThemeSectionSettings } {
  const template = parseShopifyThemeJson<SearchTemplate>(content);
  const sections = template.sections ?? {};
  const orderedIds = [
    ...(template.order ?? []),
    ...Object.keys(sections).filter((id) => !(template.order ?? []).includes(id)),
  ];

  for (const preferredType of preferredSectionTypes) {
    for (const sectionId of orderedIds) {
      const section = sections[sectionId];
      if (section?.type === preferredType) {
        return {
          found: true,
          settings: sanitizeSettings(
            section.settings as Record<string, unknown> | undefined,
          ),
        };
      }
    }
  }

  return { found: false, settings: {} };
}

export function parseTemplateSectionSettings(
  content: string,
  preferredSectionTypes: string[],
): ThemeSectionSettings {
  return findTemplateSectionSettings(content, preferredSectionTypes).settings;
}


export function parseGlobalThemeSettings(
  content: string,
): ThemeSectionSettings {
  const parsed = parseShopifyThemeJson<{
    current?: ThemeSectionSettings | string | null;
  }>(content);

  return parsed.current && typeof parsed.current === "object"
    ? sanitizeSettings(parsed.current as Record<string, unknown>)
    : {};
}

export function resolveThemeValue(
  expression: string,
  settings: ThemeSectionSettings,
): string | number | boolean | null {
  const trimmed = expression.trim();

  const sectionSettingPrefix = "section.settings.";

  if (trimmed.startsWith(sectionSettingPrefix)) {
    const settingName = trimmed.slice(sectionSettingPrefix.length);

    return settings[settingName] ?? null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  const numberValue = Number(trimmed);

  if (trimmed !== "" && Number.isFinite(numberValue)) {
    return numberValue;
  }

  return trimmed;
}

export function resolveRenderArguments(
  renderArguments: Record<string, string>,
  settings: ThemeSectionSettings,
  globalSettings: ThemeSectionSettings = {},
): Record<string, string | number | boolean | null> {
  const resolved: Record<string, string | number | boolean | null> = {};

  for (const [key, rawValue] of Object.entries(renderArguments)) {
    const value = rawValue.trim();

    if (value === "lazy_load") {
      // Renderer Bridge recalculates lazy loading from AI result position.
      resolved[key] = value;
      continue;
    }

    if (value.startsWith("section.settings.")) {
      const settingName = value.slice("section.settings.".length);
      // Missing settings should not be passed as nil because many theme
      // snippets have useful defaults when the argument is omitted entirely.
      if (Object.prototype.hasOwnProperty.call(settings, settingName)) {
        resolved[key] = settings[settingName] ?? null;
      }
      continue;
    }

    if (value.startsWith("settings.")) {
      const settingName = value.slice("settings.".length);
      if (Object.prototype.hasOwnProperty.call(globalSettings, settingName)) {
        resolved[key] = globalSettings[settingName] ?? null;
      }
      continue;
    }

    if (value === "true" || value === "false") {
      resolved[key] = value === "true";
      continue;
    }

    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      resolved[key] = value.slice(1, -1);
      continue;
    }

    const numeric = Number(value);
    if (value !== "" && Number.isFinite(numeric)) {
      resolved[key] = numeric;
      continue;
    }

    // Expressions such as section.id, forloop.index, settings.foo, variables
    // created by the original section, filters, and Liquid objects cannot be
    // safely recreated in App Proxy context. Omit them rather than converting
    // them into incorrect quoted strings.
  }

  return resolved;
}
