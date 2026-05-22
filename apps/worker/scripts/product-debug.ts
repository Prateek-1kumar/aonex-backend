#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/product-debug.ts \
//        --product-id <uuid> --tenant-id <uuid> --merchant-id <uuid> [options]
//
// Catalog redesign Phase 6 — Task 6.2.
//
// Thin CLI wrapper around the same service helper that backs
// `GET /products/:product_id/trace` (Task 6.1, see
// apps/api/src/services/new-catalog-trace.ts). Dumps the full Product Trace
// payload to stdout as pretty-printed JSON so operators can grep / pipe to
// jq without bringing up the HTTP server or wrangling auth.
//
// Sharp edges
// -----------
// 1. CROSS-APP IMPORT: `readProductTrace` lives in `apps/api`, not in any
//    workspace package. Worker depends on it via a relative path import
//    (`../../api/src/services/new-catalog-trace.js`). This is intentional
//    per Task 6.2 — extracting the helper to a shared package is scope
//    creep, and `apps/api`'s package `main` is the Bun server entrypoint
//    (side-effectful), so we can't import it through `@aonex/api`. Bun
//    resolves `.js` → `.ts` at runtime; the file isn't picked up by the
//    worker's `tsc --noEmit` (the worker tsconfig only includes `src/**/*`),
//    so the import is checked at runtime only.
//
// 2. CAMELCASE OUTPUT: the service helper returns camelCase TS types
//    (`productId`, `pricingObservations`, ...). The HTTP endpoint converts
//    to snake_case at the handler boundary; the CLI does NOT. Operators
//    grepping CLI output should expect camelCase keys.
//
// 3. TENANT + MERCHANT ARGS REQUIRED: CLI has no JWT context, so it can't
//    infer tenant/merchant from auth like the endpoint does. Both must be
//    passed explicitly. Recommended discovery:
//      psql $DATABASE_URL -c \
//        "SELECT product_id, tenant_id, merchant_id, primary_identifier
//         FROM catalog_products WHERE product_id = '<uuid>'"
//
// Exit codes:
//   0 — success, JSON written to stdout.
//   1 — bad input (missing/malformed arg) OR product not found / not
//       accessible by the given tenant+merchant. Prints a message to stderr.
//   2 — runtime error (DB connection, query failure). Prints the error.

import { createDb } from "@aonex/db";
import {
  readProductTrace,
  PRODUCT_NOT_FOUND,
} from "../../api/src/services/new-catalog-trace.js";

interface ParsedArgs {
  productId: string;
  tenantId: string;
  merchantId: string;
  since: Date | undefined;
  observationsLimit: number | undefined;
  revisionsLimit: number | undefined;
  eventsLimit: number | undefined;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun --env-file=../../.env run scripts/product-debug.ts \\
         --product-id <uuid> --tenant-id <uuid> --merchant-id <uuid> [options]

Dump the full Product Trace for a catalog product to stdout as pretty-printed JSON.
Reuses the service helper backing GET /products/:product_id/trace.

Required:
  --product-id <uuid>      Catalog product ID.
  --tenant-id <uuid>       Tenant scope. Find via:
                             SELECT tenant_id FROM catalog_products
                             WHERE product_id = '<uuid>'
  --merchant-id <uuid>     Merchant scope. Find via the same query.

Options:
  --since <iso8601>        Earliest observed_at/ingested_at/occurred_at to
                           include. Defaults to 30 days ago.
  --observations-limit <n> Cap on pricing+inventory observations.
                           Default 1000, max 5000.
  --revisions-limit <n>    Cap on revisions. Default 50, max 200.
  --events-limit <n>       Cap on events. Default 50, max 200.
  --help, -h               Print this and exit.

Output is camelCase TypeScript shapes (the service-layer types). The HTTP trace
endpoint converts to snake_case at its handler boundary; this CLI does not.

Exit codes:
  0   Success — JSON written to stdout
  1   Bad input or product not found
  2   Runtime error (DB, etc.)`);
}

/** Lenient UUID detector — matches the api handler's `looksLikeUuid`. */
function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Tiny arg parser. Supports both `--flag value` and `--flag=value` so that
 * operators copy-pasting from docs / shell history don't trip over the
 * syntax. Throws with a friendly message on bad input.
 */
function parseArgs(argv: string[]): ParsedArgs {
  let productId: string | undefined;
  let tenantId: string | undefined;
  let merchantId: string | undefined;
  let since: Date | undefined;
  let observationsLimit: number | undefined;
  let revisionsLimit: number | undefined;
  let eventsLimit: number | undefined;

  // Consume `--flag value` or `--flag=value`. For space-separated form we
  // peek at argv[i+1]; the caller is responsible for incrementing.
  function take(name: string, i: number): { value: string; consumed: number } {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      const value = arg.slice(eq + 1);
      if (value.length === 0) {
        throw new Error(`${name} requires a value`);
      }
      return { value, consumed: 1 };
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return { value: next, consumed: 2 };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--product-id" || arg.startsWith("--product-id=")) {
      const { value, consumed } = take("--product-id", i);
      productId = value;
      i += consumed - 1;
    } else if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const { value, consumed } = take("--tenant-id", i);
      tenantId = value;
      i += consumed - 1;
    } else if (arg === "--merchant-id" || arg.startsWith("--merchant-id=")) {
      const { value, consumed } = take("--merchant-id", i);
      merchantId = value;
      i += consumed - 1;
    } else if (arg === "--since" || arg.startsWith("--since=")) {
      const { value, consumed } = take("--since", i);
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`--since must be an ISO-8601 timestamp; got: ${value}`);
      }
      since = d;
      i += consumed - 1;
    } else if (
      arg === "--observations-limit" ||
      arg.startsWith("--observations-limit=")
    ) {
      const { value, consumed } = take("--observations-limit", i);
      observationsLimit = parsePositiveInt("--observations-limit", value);
      i += consumed - 1;
    } else if (
      arg === "--revisions-limit" ||
      arg.startsWith("--revisions-limit=")
    ) {
      const { value, consumed } = take("--revisions-limit", i);
      revisionsLimit = parsePositiveInt("--revisions-limit", value);
      i += consumed - 1;
    } else if (arg === "--events-limit" || arg.startsWith("--events-limit=")) {
      const { value, consumed } = take("--events-limit", i);
      eventsLimit = parsePositiveInt("--events-limit", value);
      i += consumed - 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!productId) throw new Error("--product-id is required");
  if (!tenantId) throw new Error("--tenant-id is required");
  if (!merchantId) throw new Error("--merchant-id is required");

  if (!looksLikeUuid(productId)) {
    throw new Error(`--product-id must be a UUID; got: ${productId}`);
  }
  if (!looksLikeUuid(tenantId)) {
    throw new Error(`--tenant-id must be a UUID; got: ${tenantId}`);
  }
  if (!looksLikeUuid(merchantId)) {
    throw new Error(`--merchant-id must be a UUID; got: ${merchantId}`);
  }

  return {
    productId,
    tenantId,
    merchantId,
    since,
    observationsLimit,
    revisionsLimit,
    eventsLimit,
  };
}

function parsePositiveInt(name: string, raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return n;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[product-debug] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("[product-debug] DATABASE_URL is required");
    process.exit(1);
  }

  // exactOptionalPropertyTypes is on across the repo; build the options
  // object by spreading optional keys so we don't pass `since: undefined`
  // where the service signature says `since?: Date`.
  const traceOpts: Parameters<typeof readProductTrace>[1] = {
    tenantId: args.tenantId,
    merchantId: args.merchantId,
    productId: args.productId,
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.observationsLimit !== undefined
      ? { observationsLimit: args.observationsLimit }
      : {}),
    ...(args.revisionsLimit !== undefined
      ? { revisionsLimit: args.revisionsLimit }
      : {}),
    ...(args.eventsLimit !== undefined
      ? { eventsLimit: args.eventsLimit }
      : {}),
  };

  const { client, close } = createDb(databaseUrl);
  try {
    const result = await readProductTrace(client, traceOpts);

    if (result === PRODUCT_NOT_FOUND) {
      // eslint-disable-next-line no-console
      console.error(
        "[product-debug] product not found or not accessible by tenant/merchant"
      );
      process.exit(1);
    }

    // Pretty-printed JSON to stdout. camelCase keys (see file header).
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[product-debug] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

await main();
