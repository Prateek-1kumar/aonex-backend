import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";

/**
 * Payload for the "edit and approve" reviewer action.
 *
 * The reviewer may either:
 *  - rebind a mapping (newCanonicalPath is non-null) → writes a mapping_override row
 *  - update a value without rebinding (newCanonicalPath is null) → no override created
 *  - pick one of several conflicting candidates (pickedCandidateSource set) → semantic only
 */
export interface EditApprovePayload {
  fieldName: string;
  newCanonicalPath: string | null;
  newNormalizedValue: unknown;
  pickedCandidateSource?: string;
  reason?: string;
}

export interface ResolutionContext {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  reviewerId: string;
}

export async function editAndApprove(
  _ctx: ResolutionContext,
  _taskId: string,
  _edit: EditApprovePayload
): Promise<{ overrideId: string | null }> {
  throw new Error("not implemented — Plan B Task 16");
}

export async function rejectTask(
  _ctx: ResolutionContext,
  _taskId: string,
  _reason: "wrong_value" | "missing_field" | "wrong_category" | "no_product_found",
  _note?: string
): Promise<{ failureId: string }> {
  throw new Error("not implemented — Plan B Task 17");
}

export async function mergeWithExisting(
  _ctx: ResolutionContext,
  _taskId: string,
  _existingProductId: string
): Promise<{ aliasId: string }> {
  throw new Error("not implemented — Plan B Task 18");
}

export async function resolveCluster(
  _ctx: ResolutionContext,
  _clusterKey: string,
  _action: "approve_all" | "reject_all",
  _bulkEdit?: { fieldName: string; newValue: unknown }
): Promise<{ resolvedCount: number; overridesCreated: number }> {
  throw new Error("not implemented — Plan B Task 19");
}
