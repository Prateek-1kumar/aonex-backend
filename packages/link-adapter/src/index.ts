// Public entrypoint for @aonex/link-adapter.
//
// Re-exports LinkAdapter, the createLinkAdapter / createLinkAdapterWithAntibot
// factories, and the public types (LinkAdapterDeps, EscalatedTo, BrowserFetcher,
// UnblockAdapter) from link-adapter.ts. Consumed by the worker composition root.

export {
  LinkAdapter,
  createLinkAdapter,
  createLinkAdapterWithAntibot,
  type LinkAdapterDeps,
  type EscalatedTo,
  type BrowserFetcher,
  type UnblockAdapter
} from "./link-adapter.js";
