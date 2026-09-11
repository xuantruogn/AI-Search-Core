export type PriceConstraint = {
  min: number | null;
  max: number | null;
  minInclusive: boolean;
  maxInclusive: boolean;
  currencyCode: string | null;
  source: "QUERY_TEXT";
};

type ParsedAmount = {
  value: number;
  currencyCode: string | null;
};

function normalizeForMatching(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(rawNumber: string, rawUnit = "", rawCurrency = "") {
  const unit = normalizeForMatching(rawUnit);
  const currency = normalizeForMatching(rawCurrency);
  let numericText = rawNumber.trim();

  let multiplier = 1;
  if (["k", "nghin", "ngan"].includes(unit)) multiplier = 1_000;
  if (["tr", "trieu", "m", "million"].includes(unit)) {
    multiplier = 1_000_000;
  }

  if (multiplier > 1) {
    // A suffix makes separators decimal: 1,5 triệu = 1.5 million.
    numericText = numericText.replace(",", ".");
  } else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(numericText)) {
    // Without a suffix, grouped digits are thousands: 400.000 = 400000.
    numericText = numericText.replace(/[.,]/g, "");
  } else {
    numericText = numericText.replace(",", ".");
  }

  const numericValue = Number.parseFloat(numericText);
  const value = Math.round(numericValue * multiplier);
  if (!Number.isFinite(value) || value < 0) return null;

  const hasVndUnit = ["k", "nghin", "ngan", "tr", "trieu"].includes(unit);
  const currencyCode =
    hasVndUnit || ["d", "vnd"].includes(currency)
      ? "VND"
      : ["$", "usd"].includes(currency)
        ? "USD"
        : null;

  return { value, currencyCode } satisfies ParsedAmount;
}

const AMOUNT_PATTERN =
  String.raw`(?:([$])\s*)?(\d+(?:[.,]\d+)*)(?:\s*(k|nghin|ngan|trieu|tr|million|m))?(?:\s*(vnd|usd|d))?`;

function amountFromMatch(match: RegExpMatchArray, offset: number) {
  return parseAmount(
    match[offset + 1],
    match[offset + 2] ?? "",
    match[offset] || match[offset + 3] || "",
  );
}

function mergeCurrency(...amounts: Array<ParsedAmount | null>) {
  return amounts.find((amount) => amount?.currencyCode)?.currencyCode ?? null;
}

/**
 * Extract numeric price limits deterministically. LLM expansion helps recall,
 * but embeddings must never be trusted to enforce an exact numeric budget.
 */
export function parsePriceConstraint(query: string): PriceConstraint | null {
  const normalized = normalizeForMatching(query);
  if (!normalized) return null;

  const rangePatterns = [
    new RegExp(
      String.raw`(?:tu|from|between)\s+${AMOUNT_PATTERN}\s+(?:den|toi|to|and)\s+${AMOUNT_PATTERN}`,
      "i",
    ),
    new RegExp(String.raw`${AMOUNT_PATTERN}\s*(?:-|–|—)\s*${AMOUNT_PATTERN}`, "i"),
  ];

  for (const pattern of rangePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const first = amountFromMatch(match, 1);
    const second = amountFromMatch(match, 5);
    if (!first || !second) continue;
    return {
      min: Math.min(first.value, second.value),
      max: Math.max(first.value, second.value),
      minInclusive: true,
      maxInclusive: true,
      currencyCode: mergeCurrency(first, second),
      source: "QUERY_TEXT",
    };
  }

  const maxPattern = new RegExp(
    String.raw`(?:duoi|khong qua|khong hon|toi da|den|under|below|less than|up to|at most|<=)\s*(?:gia\s*)?${AMOUNT_PATTERN}`,
    "i",
  );
  const maxMatch = normalized.match(maxPattern);
  if (maxMatch) {
    const amount = amountFromMatch(maxMatch, 1);
    if (amount) {
      return {
        min: null,
        max: amount.value,
        minInclusive: true,
        maxInclusive: !/^(?:duoi|under|below|less than|<(?!=))/i.test(
          maxMatch[0],
        ),
        currencyCode: amount.currencyCode,
        source: "QUERY_TEXT",
      };
    }
  }

  const postfixMaxMatch = normalized.match(
    new RegExp(
      String.raw`${AMOUNT_PATTERN}\s*(?:tro xuong|or less|or lower|maximum|max)`,
      "i",
    ),
  );
  if (postfixMaxMatch) {
    const amount = amountFromMatch(postfixMaxMatch, 1);
    if (amount) {
      return {
        min: null,
        max: amount.value,
        minInclusive: true,
        maxInclusive: true,
        currencyCode: amount.currencyCode,
        source: "QUERY_TEXT",
      };
    }
  }

  const minPattern = new RegExp(
    String.raw`(?:tren|hon|tu|it nhat|toi thieu|over|above|more than|at least|from|>=)\s*(?:gia\s*)?${AMOUNT_PATTERN}`,
    "i",
  );
  const minMatch = normalized.match(minPattern);
  if (minMatch) {
    const amount = amountFromMatch(minMatch, 1);
    if (amount) {
      return {
        min: amount.value,
        max: null,
        minInclusive: !/^(?:tren|hon|over|above|more than|>(?!=))/i.test(
          minMatch[0],
        ),
        maxInclusive: true,
        currencyCode: amount.currencyCode,
        source: "QUERY_TEXT",
      };
    }
  }

  const postfixMinMatch = normalized.match(
    new RegExp(
      String.raw`${AMOUNT_PATTERN}\s*(?:tro len|or more|or higher|minimum|min)`,
      "i",
    ),
  );
  if (postfixMinMatch) {
    const amount = amountFromMatch(postfixMinMatch, 1);
    if (amount) {
      return {
        min: amount.value,
        max: null,
        minInclusive: true,
        maxInclusive: true,
        currencyCode: amount.currencyCode,
        source: "QUERY_TEXT",
      };
    }
  }

  return null;
}

export function productPriceMatchesConstraint(
  priceRange: {
    min: number;
    max: number;
    currencyCode: string;
  },
  constraint: PriceConstraint,
) {
  if (
    constraint.currencyCode &&
    priceRange.currencyCode.toUpperCase() !== constraint.currencyCode
  ) {
    return false;
  }

  // Compare against the lowest variant price because that is normally the
  // price exposed on a Shopify product card.
  if (
    constraint.max !== null &&
    (priceRange.min > constraint.max ||
      (!constraint.maxInclusive && priceRange.min === constraint.max))
  ) {
    return false;
  }
  // Product cards normally expose the lowest variant price. Requiring that
  // displayed/base price to meet the lower bound prevents a 22k product with
  // one expensive variant from appearing in a "trên 400k" search.
  if (
    constraint.min !== null &&
    (priceRange.min < constraint.min ||
      (!constraint.minInclusive && priceRange.min === constraint.min))
  ) {
    return false;
  }
  return true;
}
