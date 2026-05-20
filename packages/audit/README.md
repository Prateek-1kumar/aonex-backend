# @aonex/audit

Append-only audit event emitter — every state change in the system emits exactly one structured audit record.

## Exports

- `AuditEmitter` — port interface: `emit(event: AuditEventInput): Promise<void>`
- `AuditEventInput` — shape of an audit event (tenantId, actorType, eventType, entityType, etc.)
- `ActorType` — union: `"user" | "system" | "policy" | "worker" | "nango"`
- `PostgresAuditEmitter` — production implementation backed by `@aonex/db`
- `InMemoryAuditEmitter` — spy for tests; exposes `.events[]` and `.reset()`

## How it fits

Both `apps/api` and `apps/worker` use the `PostgresAuditEmitter` wired in their composition root. All services receive the `AuditEmitter` port; tests substitute `InMemoryAuditEmitter`.

## Dependencies

- `@aonex/db`
- `@aonex/types`
