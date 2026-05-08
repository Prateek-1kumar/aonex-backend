// dependency-cruiser config — enforces architectural boundaries
// from the HLD's 4-plane model and the engineering principles doc.
//
// Failures here are CI failures, not warnings.

module.exports = {
  forbidden: [
    {
      name: "no-cross-app-imports",
      severity: "error",
      comment:
        "apps/api and apps/worker are independent processes. They communicate via Redis (BullMQ) and never via direct imports. (LLD I3, HLD §6.)",
      from: { path: "^apps/(api|worker)" },
      to: { path: "^apps/(api|worker)", pathNot: "^apps/(api|worker)/[^/]+/$" }
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)(turbo|drizzle)\\.config\\.(js|cjs|mjs|ts)$"
        ]
      },
      to: {}
    },
    {
      name: "nango-only-in-gateway",
      severity: "error",
      comment:
        "The Connector Gateway is the only integration boundary (HLD §17). @nangohq/node may only be imported inside packages/connector-gateway/src/adapters/nango/.",
      from: { pathNot: "^packages/connector-gateway/src/adapters/nango/" },
      to: { path: "^@nangohq/node" }
    },
    {
      name: "drizzle-only-in-db",
      severity: "error",
      comment:
        "drizzle-orm may only be imported inside packages/db. Repositories are the abstraction (engineering principles doc).",
      from: { pathNot: "^packages/db/" },
      to: { path: "^drizzle-orm" }
    },
    {
      name: "bullmq-only-in-queues-and-roots",
      severity: "error",
      comment:
        "bullmq imports are restricted to composition roots and the worker app. Routes/services declare narrow ports.",
      from: {
        pathNot: [
          "^apps/api/src/composition-root\\.ts$",
          "^apps/api/src/queues/",
          "^apps/worker/src/"
        ]
      },
      to: { path: "^bullmq$" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"]
    }
  }
};
