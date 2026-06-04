// Public surface of `@aonex/audit` — the append-only audit fact log (HLD §6).
//
// Re-exports the AuditEmitter port + AuditEventInput contract, the
// PostgresAuditEmitter default impl (wired in the composition root), and the
// InMemoryAuditEmitter spy used by tests.

export * from "./audit-emitter.js";
export * from "./postgres-audit-emitter.js";
