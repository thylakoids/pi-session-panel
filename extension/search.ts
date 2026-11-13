/** Search, matching `pi -r` exactly. */
import { fuzzyMatch } from "@earendil-works/pi-tui";

export interface ParsedSearch {
  mode: "tokens" | "regex";
  tokens: { kind: "fuzzy" | "phrase"; value: string }[];
  regex: RegExp | null;
  /** Set when the query itself is invalid; nothing matches. */
  error?: string;
}

function normalizeWhitespaceLower(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Parse a query the way pi's session picker does. */
export function parseSearch(query: string): ParsedSearch {
  const trimmed = query.trim();
  if (!trimmed) return { mode: "tokens", tokens: [], regex: null };

  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (error) {
      return { mode: "regex", tokens: [], regex: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const tokens: ParsedSearch["tokens"] = [];
  let buffer = "";
  let inQuote = false;
  const flush = (kind: "fuzzy" | "phrase") => {
    const value = buffer.trim();
    buffer = "";
    if (value) tokens.push({ kind, value });
  };
  for (const character of trimmed) {
    if (character === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(character)) {
      flush("fuzzy");
      continue;
    }
    buffer += character;
  }

  // Match pi -r: unbalanced quotes fall back to whitespace tokens.
  if (inQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((part) => ({ kind: "fuzzy" as const, value: part })),
      regex: null,
    };
  }

  flush("fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

/** Whether one haystack matches, and how well (lower is better). */
export function matchSearch(text: string, parsed: ParsedSearch): { matches: boolean; score: number } {
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const index = text.search(parsed.regex);
    return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
  }
  if (parsed.tokens.length === 0) return { matches: true, score: 0 };

  let total = 0;
  let normalized: string | null = null;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalized === null) normalized = normalizeWhitespaceLower(text);
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      const index = normalized.indexOf(phrase);
      if (index < 0) return { matches: false, score: 0 };
      total += index * 0.1;
      continue;
    }
    const result = fuzzyMatch(token.value, text);
    if (!result.matches) return { matches: false, score: 0 };
    total += result.score;
  }
  return { matches: true, score: total };
}
