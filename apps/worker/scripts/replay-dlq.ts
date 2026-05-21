#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/replay-dlq.ts [flags]
//
// Catalog redesign Phase 5 — Task 5.5 — manual ops entrypoint for
// `replayDlq` from `@aonex/catalog-event-outbox`. See dlq.ts for the
// authoritative semantics; this script is a thin CLI shell around it.
//
// Flags (minimal arg parsing — no external library):
//   --event-ids=<csv>   Comma-separated list of catalog_events_dlq.event_id
//                       values to replay. If omitted, ALL DLQ entries up to
//                       --limit are considered (failed_at ASC).
//   --limit=<N>         Cap rows replayed in one call. Default 1000.
//   --dry-run           Log the plan but do NOT mutate the database. Useful
//                       for verifying which DLQ rows would be replayed before
//                       committing.
//   --help, -h          Print usage and exit.
//
// Exit codes:
//   0 — success (including dry-run and "nothing to replay" outcomes).
//   1 — bad input (unknown flag, malformed --event-ids, missing
//       DATABASE_URL, etc.). Prints a usage hint.
//   2 — runtime failure (DB error during replay). Prints the error.
//
// Output: a small JSON object with the `ReplayDlqResult` shape so this
// script is easy to compose with `jq` or shell pipelines.

import { createDb } from "@aonex/db";
import { replayDlq } from "@aonex/catalog-event-outbox";

interface ParsedArgs {
  eventIds: number[] | undefined;
  limit: number | undefined;
  dryRun: boolean;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun --env-file=../../.env run scripts/replay-dlq.ts [flags]

Flags:
  --event-ids=1,2,3   Replay specific catalog_events_dlq.event_id values.
                      If omitted, replay all DLQ entries (capped by --limit).
  --limit=N           Max rows replayed in one call. Default 1000.
  --dry-run           Print the plan; do not mutate the database.
  -h, --help          Show this message.

Examples:
  bun --env-file=../../.env run scripts/replay-dlq.ts --dry-run
  bun --env-file=../../.env run scripts/replay-dlq.ts --event-ids=42,43,44
  bun --env-file=../../.env run scripts/replay-dlq.ts --limit=50

Exit codes: 0=ok, 1=bad input, 2=runtime error.`);
}

/**
 * Tiny arg parser — handles the three flag shapes this script needs:
 *   --flag                    (boolean)
 *   --flag=value              (key=value)
 *   --flag value              (space-separated; not used here but tolerated)
 *
 * Returns parsed values or throws with a friendly message on bad input.
 */
function parseArgs(argv: string[]): ParsedArgs {
  let eventIds: number[] | undefined;
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--event-ids=")) {
      const raw = arg.slice("--event-ids=".length);
      if (raw.length === 0) {
        throw new Error("--event-ids requires a comma-separated list of bigints");
      }
      const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length === 0) {
        throw new Error("--event-ids has no values after parsing");
      }
      const parsed: number[] = [];
      for (const p of parts) {
        const n = Number(p);
        // We accept any finite integer; BIGSERIAL values fit safely in
        // Number well past 2^53 for any realistic id density.
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          throw new Error(`--event-ids contains a non-positive-integer value: ${p}`);
        }
        parsed.push(n);
      }
      eventIds = parsed;
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer; got: ${raw}`);
      }
      limit = n;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { eventIds, limit, dryRun };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[replay-dlq] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("[replay-dlq] DATABASE_URL is required");
    process.exit(1);
  }

  const { client, close } = createDb(databaseUrl);
  try {
    const result = await replayDlq(
      { db: client },
      {
        eventIds: args.eventIds,
        limit: args.limit,
        dryRun: args.dryRun
      }
    );

    // JSON to stdout so the output is composable; humans can read it too.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    if (result.missingSource > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[replay-dlq] WARNING: ${result.missingSource} DLQ row(s) had no matching catalog_events row and were LEFT in catalog_events_dlq for operator review.`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[replay-dlq] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

await main();
