// Shared test stub for ReconcilerQueueProvider.
// Avoids Redis and satisfies the name-check inside enqueueReconcilerJob
// (queue.name must equal reconcilerQueueName(tenantId)).
//
// Usage:
//   import { noopReconcilerQueues } from "../testing/reconciler-queue-stub.js";
//   runCsvParse({ db, audit, reconcilerQueues: noopReconcilerQueues }, ...)

import { reconcilerQueueName } from "@aonex/catalog-service";
import type { ReconcilerQueueProvider } from "../services/reconciler-queue-provider.js";

export const noopReconcilerQueues: ReconcilerQueueProvider = {
  forTenant: (tenantId: string) =>
    ({
      name: reconcilerQueueName(tenantId),
      add: async () => ({} as never),
    }) as never,
  close: async () => {},
} as unknown as ReconcilerQueueProvider;
