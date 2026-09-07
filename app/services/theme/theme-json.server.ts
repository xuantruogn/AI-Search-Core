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

