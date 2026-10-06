export const SEMANTIC_CONTRACT_VERSION = "supply-demand-v2-joint-evidence";

/** Recall-only contract. Never feed these fields into exact fact collectors. */
export const SEMANTIC_AXES = ["identity", "purpose", "useCase", "context", "quality", "audience", "style"] as const;

export type SemanticSupplyProfile = {
  identity: string[];
  purposes: string[];
  useCases: string[];
  contexts: string[];
  qualities: string[];
  audience: string[];
  styles: string[];
  semanticExplicit: string[];
  semanticInferred: string[];
};

export type SemanticDemandProfile = {
  identity: string[];
  desiredOutcomes: string[];
  useCases: string[];
  contexts: string[];
  qualities: string[];
  audience: string[];
  styles: string[];
  negativeConstraints: string[];
  exactConstraints: string[];
};

export const SUPPLY_AXES = ["identity", "purposes", "useCases", "contexts", "qualities", "audience", "styles", "semanticExplicit", "semanticInferred"] as const;
export const DEMAND_AXES = ["identity", "desiredOutcomes", "useCases", "contexts", "qualities", "audience", "styles", "negativeConstraints", "exactConstraints"] as const;

export function semanticProfileSchema(keys: readonly string[]) {
  return {
    type: "object",
    properties: Object.fromEntries(
      keys.map((key) => [
        key,
        { type: "array", items: { type: "string" } },
      ]),
    ),
    required: [...keys],
    additionalProperties: false,
  };
}

export const semanticSupplySchema = semanticProfileSchema(SUPPLY_AXES);
export const semanticDemandSchema = semanticProfileSchema(DEMAND_AXES);

export function compactSemanticValues(value: unknown, limit = 6): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.replace(/\s+/g, " ").trim().slice(0, 180))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

export function parseSemanticProfile<T>(
  value: unknown,
  keys: readonly string[],
): T | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    keys.some(
      (key) =>
        !Array.isArray(record[key]) ||
        (record[key] as unknown[]).some((v) => typeof v !== "string"),
    )
  ) {
    return null;
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      compactSemanticValues(record[key], key.startsWith("semantic") ? 32 : 6),
    ]),
  ) as T;
}

export const parseSemanticSupplyProfile = (value: unknown) =>
  parseSemanticProfile<SemanticSupplyProfile>(value, SUPPLY_AXES);
export function normalizeSemanticDemandProfile(
  profile: SemanticDemandProfile,
): SemanticDemandProfile {
  // Semantic axes describe meaning for dense retrieval. exactConstraints are
  // reserved for closed-world facts that code/PSF may enforce. LLMs can
  // occasionally duplicate a semantic context/quality (for example "summer")
  // into exactConstraints; remove only exact duplicate meanings here rather
  // than guessing domain-specific constraint types.
  const semanticMeaning = new Set(
    [
      ...profile.identity,
      ...profile.desiredOutcomes,
      ...profile.useCases,
      ...profile.contexts,
      ...profile.qualities,
      ...profile.audience,
      ...profile.styles,
    ].map(semanticKey),
  );
  const negative = new Set(profile.negativeConstraints.map(semanticKey));
  return {
    ...profile,
    exactConstraints: profile.exactConstraints.filter((value) => {
      const key = semanticKey(value);
      return Boolean(key) && !semanticMeaning.has(key) && !negative.has(key);
    }),
  };
}

export const parseSemanticDemandProfile = (value: unknown) => {
  const parsed = parseSemanticProfile<SemanticDemandProfile>(value, DEMAND_AXES);
  return parsed ? normalizeSemanticDemandProfile(parsed) : null;
};

export const emptySemanticSupplyProfile = (): SemanticSupplyProfile =>
  Object.fromEntries(SUPPLY_AXES.map((key) => [key, []])) as unknown as SemanticSupplyProfile;
export const emptySemanticDemandProfile = (): SemanticDemandProfile =>
  Object.fromEntries(DEMAND_AXES.map((key) => [key, []])) as unknown as SemanticDemandProfile;

function list(values: string[]) {
  return values.length < 2
    ? values[0] ?? ""
    : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

// Structured constraints, identifiers and quantities stay in lexical/PSF lanes.
function meaning(values: string[]) {
  return compactSemanticValues(values).filter(
    (v) => !/\d|[=|;]|\b(?:sku|barcode|compatibility|price)\b/i.test(v),
  );
}

function semanticKey(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function takeUnseen(
  values: string[],
  seen: Set<string>,
  blocked?: Set<string>,
) {
  const result: string[] = [];
  for (const value of meaning(values)) {
    const key = semanticKey(value);
    if (!key || seen.has(key) || blocked?.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function renderSemanticSupply(profile: SemanticSupplyProfile) {
  const sentences: string[] = [];
  const seen = new Set<string>();

  const identity = takeUnseen(profile.identity, seen).slice(0, 2);
  if (identity.length) sentences.push(`This product is ${list(identity)}.`);

  for (const [prefix, values] of [
    ["It helps with", profile.purposes],
    ["It is suitable for", profile.useCases],
    ["It can be used in", profile.contexts],
    ["It offers", profile.qualities],
    ["It is intended for", profile.audience],
    ["Its style is", profile.styles],
  ] as const) {
    const clean = takeUnseen([...values], seen);
    if (clean.length) sentences.push(`${prefix} ${list(clean)}.`);
  }

  // Provenance arrays classify axis values; they are not rendered as extra terms.
  return sentences.join(" ").slice(0, 1800);
}

export function renderSemanticDemand(profile: SemanticDemandProfile) {
  const sentences: string[] = [];
  const seen = new Set<string>();

  // Only negative constraints suppress positive dense meaning. Exact constraints
  // remain separately code/PSF-owned, but must not erase a semantic context if
  // a model accidentally duplicates e.g. "summer" into exactConstraints.
  const blocked = new Set(profile.negativeConstraints.map(semanticKey));

  const identity = takeUnseen(profile.identity, seen, blocked);
  if (identity.length) sentences.push(`Looking for ${list(identity)}.`);

  for (const [prefix, values] of [
    ["The goal is", profile.desiredOutcomes],
    ["For", profile.useCases],
    ["To use in", profile.contexts],
    ["With", profile.qualities],
    ["For", profile.audience],
    ["With a style of", profile.styles],
  ] as const) {
    const clean = takeUnseen([...values], seen, blocked);
    if (clean.length) sentences.push(`${prefix} ${list(clean)}.`);
  }

  return sentences.join(" ").slice(0, 1200);
}

export function composeSemanticMeaning(
  profile: SemanticSupplyProfile | SemanticDemandProfile,
) {
  return "purposes" in profile
    ? renderSemanticSupply(profile)
    : renderSemanticDemand(profile);
}

