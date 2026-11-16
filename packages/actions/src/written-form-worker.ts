/// <reference lib="webworker" />
// Worker thread entry: runs the Written form converter off the main event loop. See written-form-pool.ts.
import { markdownToDocWithWarnings, rawTextDocument, resolverFromReferences, type MarkdownOptions } from "./markdown-doc";
import { prepareRichText, writtenFormOfSync } from "./rich-markdown";

const withResolver = (options: MarkdownOptions = {}): MarkdownOptions => options.references ? { ...options, resolveReference: resolverFromReferences(options.references) } : options;

self.onmessage = (event: MessageEvent<{ id: number; op: string; args: unknown[] }>) => {
  const { id, op, args } = event.data;
  try {
    let value: unknown;
    if (op === "prepare") { const a = args as Parameters<typeof prepareRichText>; value = prepareRichText(a[0], a[1], a[2], a[3], withResolver(a[4]), a[5], a[6]); }
    else if (op === "writtenForm") value = writtenFormOfSync(args[0]);
    else if (op === "parse") value = markdownToDocWithWarnings(args[0] as string, withResolver(args[1] as MarkdownOptions));
    else if (op === "storedRead") value = markdownToDocWithWarnings(args[0] as string, { ...withResolver(args[1] as MarkdownOptions), storedRead: true });
    else if (op === "storedReadMany") {
      // Each row is reported as it finishes, so the pool can time every row on its own and keep what is done.
      const items = args[0] as Array<{ markdown: string; options: MarkdownOptions }>;
      for (let index = 0; index < items.length; index++) {
        let result;
        try { result = markdownToDocWithWarnings(items[index]!.markdown, { ...withResolver(items[index]!.options), storedRead: true }); } catch { result = rawTextDocument(items[index]!.markdown); }
        postMessage({ id, progress: { index, value: result } });
      }
      value = null;
    }
    else if (op === "warm") { markdownToDocWithWarnings("warm *up* [x](https://example.com)", {}); value = true; }
    else throw new Error(`Unknown converter operation ${op}`);
    postMessage({ id, ok: true, value });
  } catch (error) {
    const failure = error as { message?: string; status?: number; code?: string };
    // An error with a status is a refusal the caller can read; anything else is an internal fault the pool reports generically.
    postMessage({ id, ok: false, error: { message: failure?.message ?? String(error), status: failure?.status, code: failure?.code, internal: typeof failure?.status !== "number" } });
  }
};

// Tell the pool the module is loaded, so a job's clock starts when the thread can actually work.
postMessage({ ready: true });
