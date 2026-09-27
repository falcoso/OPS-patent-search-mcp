import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpoClient } from "../epo-client.js";
import { parseLegalEvents, type LegalEvent } from "../parsers.js";
import { wrapJsonTool } from "../helpers.js";
import { isGrantEvent, isSpcEvent, summarizeLegalStatus } from "../legal.js";
import { resolveAndFetch } from "../fallback.js";
import { documentNumberParam } from "./params.js";

type GetPatentLegalStatusArgs = {
  document_number: string;
  event_types?: Array<"grant" | "lapse" | "opposition" | "spc_pte" | "withdrawal" | "abandonment" | "fee_payment">;
  condensed: boolean;
};

export async function getPatentLegalStatus(
  client: EpoClient,
  { document_number, event_types, condensed }: GetPatentLegalStatusArgs,
) {
  client.startToolCall();
  const { raw, resolvedAs } = await resolveAndFetch(client, document_number, (d, f) =>
    client.getLegalStatus(d, f)
  );
  const events = parseLegalEvents(raw);

  // Derive a high-level status summary from event codes/descriptions
  const statusSummary = summarizeLegalStatus(events);

  // Filter events by category if requested
  let filteredEvents = events;
  if (event_types && event_types.length > 0) {
    const typeSet = new Set(event_types);
    filteredEvents = events.filter((e) => {
      const code = (e.eventCode ?? "").toUpperCase();
      const desc = (e.description ?? "").toLowerCase();
      if (typeSet.has("grant") && isGrantEvent(e)) return true;
      if (typeSet.has("lapse") && (code === "PG25" || desc.includes("lapse") || desc.includes("ceased") || desc.includes("expired") || desc.includes("not in force"))) return true;
      if (typeSet.has("opposition") && (code.startsWith("OPP") || (desc.includes("opposition") && !desc.includes("no opposition")))) return true;
      if (typeSet.has("spc_pte") && isSpcEvent(e)) return true;
      if (typeSet.has("withdrawal") && (desc.includes("withdrawn") || desc.includes("withdrawal"))) return true;
      if (typeSet.has("abandonment") && (code === "STCB" || desc.includes("abandoned"))) return true;
      if (typeSet.has("fee_payment") && code === "PGFP") return true;
      return false;
    });
  }

  // Condensed mode: collapse PGFP fee payments into per-state summaries
  if (condensed) {
    const nonPgfp = filteredEvents.filter((e) => e.eventCode !== "PGFP");
    const pgfpByState = new Map<string, { latest: string; years: string[] }>();
    for (const e of filteredEvents) {
      if (e.eventCode !== "PGFP" || !e.refCountryCode) continue;
      const state = e.refCountryCode;
      const existing = pgfpByState.get(state);
      if (!existing || (e.date ?? "") > existing.latest) {
        pgfpByState.set(state, {
          latest: e.date ?? "",
          years: [...(existing?.years ?? []), e.yearOfFeePayment ?? ""].filter(Boolean),
        });
      } else {
        existing.years.push(e.yearOfFeePayment ?? "");
      }
    }
    const pgfpSummaries: LegalEvent[] = [...pgfpByState.entries()].map(([state, info]) => ({
      eventCode: "PGFP",
      description: `Annual fee paid — ${info.years.length} payments`,
      refCountryCode: state,
      date: info.latest,
      yearOfFeePayment: info.years.sort().join(","),
    }));
    filteredEvents = [...nonPgfp, ...pgfpSummaries].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  return {
    documentNumber: document_number,
    ...(resolvedAs !== document_number && { resolvedAs, note: `Resolved ${document_number} as ${resolvedAs}.` }),
    statusSummary,
    totalEvents: events.length,
    filteredEvents: filteredEvents.length,
    legalEvents: filteredEvents,
  };
}

export function registerGetPatentLegalStatus(server: McpServer, client: EpoClient) {
  server.registerTool(
    "get_patent_legal_status",
    {
      description: `Get the legal status history for a patent: grant events, oppositions, lapsing, withdrawals, etc.

IMPORTANT — LEGAL: Only report legal status based on events returned by this tool. Never guess whether a patent is in force, expired, or withdrawn.

Use this to determine whether a patent is currently in force (granted and not lapsed), pending (application), or expired/withdrawn — which changes its competitive significance significantly.

Returns a statusSummary object with:
- Flags: granted, lapsed, oppositionFiled, spcOrPte
- spcStates: EP contracting states with an SPC registration
- SPC certificate numbers themselves (kind I1/I2/C1, e.g. LU92936I) have no legal-status record: OPS files SPC events under the basic patent (EP2170959), so query that number
- SPC expiry is not provided by OPS; spcOrPteDetails carries the marketing-authorisation number and date from the national register entry, from which the term can be estimated
- statusSummary is always computed from the full event list; event_types only filters the legalEvents echoed back
- keyEvents: human-readable summary of important events
- lapsedStates: EP contracting state codes where patent has lapsed (from PG25 events, e.g. ["AT","CH","CY","DE"])
- activeStates: EP contracting state codes where annual fees are paid (from PGFP events, e.g. ["FR","GB","NL"])
- spcOrPteDetails: free text with SPC/PTE duration or details when available

Plus the full list of raw legal events. Each event now includes refCountryCode (contracting state), effectiveDate, freeText, and yearOfFeePayment when available from the OPS data.`,
    inputSchema: {
      document_number: documentNumberParam.describe('Patent publication number, e.g. "EP1000000" or "US10000000"'),
      event_types: z
        .array(z.enum(["grant", "lapse", "opposition", "spc_pte", "withdrawal", "abandonment", "fee_payment"]))
        .optional()
        .describe('Filter to specific event categories. Omit to return all events. Use ["grant", "lapse", "spc_pte"] for a concise view.'),
      condensed: z
        .boolean()
        .default(false)
        .describe("When true, collapse repetitive events (e.g. annual PGFP fee payments per state) into summaries. Useful for patents with 100+ events."),
    },
    annotations: { readOnlyHint: true },
  },
    wrapJsonTool(client, getPatentLegalStatus, { grounding: true }),
  );
}
