/**
 * Automatic session naming. See docs/adr/0007.
 *
 * One check decides everything: a session with no name and at least one user
 * message gets a name. That single rule covers every scenario — a fresh session
 * after its first prompt, a resumed session that never had a name, and a retry
 * after a failed attempt — so there is no scenario-specific branching.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Sent verbatim. Short on purpose: this runs on a cheap model. */
const PROMPT =
  "Write a short title (at most 6 words) for a coding-agent session, based on the user's request below. " +
  "Use the request's language. Reply with the title only, no quotes or trailing punctuation.";

/** Text of the first user message on the active branch, or undefined. */
export function firstUserText(context: ExtensionContext): string | undefined {
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
              .join(" ")
          : "";
    const first = text.split("\n").find((line) => line.trim().length > 0);
    if (first?.trim()) return first.trim();
  }
  return undefined;
}

/** Trim a model reply down to something safe to store as a name. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。,，;；:：]+$/g, "")
    .trim()
    .slice(0, 60);
}

export interface NamerOptions {
  pi: ExtensionAPI;
  /** Model as `provider/model`, or undefined to disable naming. */
  model: () => string | undefined;
  /** Called after a name is written, so the host can refresh its registry record. */
  onNamed?: (name: string) => void;
}

/**
 * Resolve `provider/model` against the live registry.
 *
 * Model ids may themselves contain slashes ("auto/glm-5.3-flash"), so only the
 * first slash separates provider from id. Failing that, try the whole spec as an
 * id under every provider: the registry is the authority, not the string shape.
 */
export function resolveModel(registry: ExtensionContext["modelRegistry"], spec: string) {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const direct = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (direct) return direct;
  }
  for (const provider of registry.getRegisteredProviderIds()) {
    const model = registry.find(provider, spec);
    if (model) return model;
  }
  return undefined;
}

/**
 * Returns `maybeName`. It is safe to call from any hook, as often as you like:
 * it returns immediately when there is nothing to do, and it never throws.
 */
export function createNamer(options: NamerOptions) {
  /** True only while a model call is in flight, so two hooks cannot race. */
  let generating = false;

  /**
   * `text` is the prompt that just arrived. At `before_agent_start` it is not on the
   * branch yet, so it has to be passed in; when it is absent, the branch is used,
   * which is what a resumed session needs.
   */
  return async function maybeName(context: ExtensionContext, text?: string): Promise<void> {
    if (generating) return;
    if (context.sessionManager.getSessionName()?.trim()) return;
    const source = text?.trim() || firstUserText(context);
    if (!source) return;

    const spec = options.model();
    if (!spec) return;

    const model = resolveModel(context.modelRegistry, spec);
    if (!model) return;

    generating = true;
    try {
      const reply = await context.modelRegistry.complete(model, {
        messages: [{ role: "user", content: `${PROMPT}\n\n---\n${source}`, timestamp: Date.now() }],
      });
      const title = cleanTitle(
        reply.content.map((part) => (part.type === "text" ? part.text : "")).join(" "),
      );
      if (!title) return;
      options.pi.setSessionName(title);
      options.onNamed?.(title);
    } catch {
      // Naming is a convenience. A failure must never surface, and the next
      // trigger tries again.
    } finally {
      generating = false;
    }
  };
}
