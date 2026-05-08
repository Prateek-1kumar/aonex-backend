// Worker entry. Bun + BullMQ Workers.

import { buildContainerFromEnv } from "./composition-root.js";

const container = buildContainerFromEnv();
await container.start();
console.log(`[aonex-worker] running (${container.env.NODE_ENV})`);

const stop = async (sig: string) => {
  console.log(`[aonex-worker] received ${sig} — draining`);
  await container.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
