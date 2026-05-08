// Bun entry point. Web Standards `Request`/`Response` flows.

import { buildContainerFromEnv } from "./composition-root.js";

const { app, env, shutdown } = buildContainerFromEnv();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch
});

console.log(`[aonex-api] listening on http://localhost:${server.port} (${env.NODE_ENV})`);

const stop = async (sig: string) => {
  console.log(`[aonex-api] received ${sig} — draining`);
  server.stop();
  await shutdown();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
