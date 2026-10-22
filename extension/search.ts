/**
 * Search, matching `pi -r` exactly.
 *
 * pi builds its haystack as `${id} ${name ?? ""} ${allMessagesText} ${cwd}` and
 * then applies either a regex (`re:...`) or a list of tokens where a bare word
 * is a fuzzy match and a "quoted phrase" must appear verbatim. This reproduces
 * both, because a panel that searches differently from the command it mirrors is
 * worse than no search at all.
 *
 * The parser and matcher live in pi's session picker, which is not exported from
 * the package entry point, so they are reproduced here against the same
 * primitives (pi-tui's `fuzzyMatch`).
 */
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
    buffer += character;
  }
  flush(inQuote ? "phrase" : "fuzzy");
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
