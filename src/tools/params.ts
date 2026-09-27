import { z } from "zod";

export const documentNumberParam = z
  .string()
  .describe(
    'Publication or application number in any common written form, e.g. "EP1393417", "EP.1393417.B1", "US 2024/0318857 A1", "EP02729749", "PCT/US2020/012345". Kind code optional; including it (e.g. B1) selects that exact publication.'
  );

export const fallbackToFamilyParam = z
  .boolean()
  .default(true)
  .describe(
    "If full text is not available for this document, automatically try family members (EP/WO preferred). Default true."
  );
