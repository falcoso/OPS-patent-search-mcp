import { EpoClient, type ThrottleStatus } from "./epo-client.js";

export const GROUNDING_NOTICE =
  "GROUNDING: Only patent numbers, dates, names, and text that appear in this response may be cited in your output. Never supplement with patent numbers from your own knowledge. When quoting patent claims or description passages, use the exact text returned here — do not paraphrase from memory.";

type ThrottleSource = { lastThrottle: ThrottleStatus | null };

export function createClient() {
  const CONSUMER_KEY = process.env.PATENT_CONSUMER_KEY;
  const CONSUMER_SECRET = process.env.PATENT_CONSUMER_SECRET_KEY;
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    throw new Error("Missing PATENT_CONSUMER_KEY or PATENT_CONSUMER_SECRET_KEY environment variables");
  }
  return new EpoClient(CONSUMER_KEY, CONSUMER_SECRET);
}

export function createHelpers(client: ThrottleSource) {
  function errorResult(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const throttle = client.lastThrottle;
    const parts = [`Error: ${msg}`];
    if (/ambiguous/i.test(msg)) {
      parts.push(
        `\nHint: OPS found several publications for this number (e.g. A1 and B1). Give a kind code in docdb format, e.g. "EP.1234567.B1", or use epodoc format ("EP1234567") to take the first one.`
      );
    }
    if (/3 characters required when '\*'/i.test(msg)) {
      parts.push(
        `\nHint: hyphens split a term into tokens, so freeze-dr* is read as dr*. Use the full word ("freeze-drying") or an unhyphenated stem with at least 3 characters before the *.`
      );
    }
    if (throttle?.isThrottled) {
      parts.push(
        `\nRate limit status: ${throttle.overallStatus}. ` +
        Object.entries(throttle.services)
          .filter(([, s]) => s.color !== "green")
          .map(([name, s]) => `${name}=${s.color}:${s.remaining}`)
          .join(", ") +
        `. Wait 1-2 minutes before retrying.`
      );
    }
    return {
      content: [{ type: "text" as const, text: parts.join("") }],
      isError: true,
    };
  }

  function jsonResult(data: unknown, { grounding = false }: { grounding?: boolean } = {}) {
    const enriched = appendThrottleInfo(data);
    const content: { type: "text"; text: string }[] = [
      { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
    ];
    if (grounding) {
      content.push({ type: "text" as const, text: GROUNDING_NOTICE });
    }
    return { content };
  }

  /** Append a compact throttle summary to any response object when rate limits are approaching. */
  function appendThrottleInfo(data: unknown): unknown {
    const throttle = client.lastThrottle;
    if (!throttle) return data;

    const quota: Record<string, unknown> = {};
    for (const [service, status] of Object.entries(throttle.services)) {
      quota[service] = { remaining: status.remaining, status: status.color };
    }

    const throttleInfo = {
      overallStatus: throttle.overallStatus,
      isThrottled: throttle.isThrottled,
      quota,
      ...(throttle.isThrottled && {
        warning: "EPO OPS rate limits are approaching. Space out requests or wait 1-2 minutes to avoid timeouts.",
      }),
    };

    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return { ...data, _throttle: throttleInfo };
    }
    return data;
  }

  return { errorResult, jsonResult, appendThrottleInfo };
}

/** MCP handler that runs a standalone tool function and wraps the result with jsonResult / errorResult. */
export function wrapJsonTool<TArgs>(
  client: EpoClient,
  run: (client: EpoClient, args: TArgs) => Promise<unknown>,
  options: { grounding?: boolean } = {},
) {
  return async (args: TArgs) => {
    const { jsonResult, errorResult } = createHelpers(client);
    try {
      return jsonResult(await run(client, args), options);
    } catch (e) {
      return errorResult(e);
    }
  };
}
