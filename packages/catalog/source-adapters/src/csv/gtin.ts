// GTIN validation — re-exported from the shared kernel (@aonex/lib-utils),
// which owns the single GS1 implementation (exact 8/12/13/14 length + mod-10
// check digit). Kept as a module so adapter-internal imports stay stable.

export { gtinCheckDigit, gtinIssue, isValidGtin, type GtinIssue } from "@aonex/lib-utils";
