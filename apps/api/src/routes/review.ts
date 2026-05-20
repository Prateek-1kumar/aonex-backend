import { Hono } from "hono";
import type { DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import {
  listReviewTasks,
  listReviewClusters,
  getClusterItems,
  resolveReviewCluster,
  editAndApproveTask,
  patchReviewTask,
  rejectReviewTask,
  mergeReviewTask,
  getTaskEvidence,
} from "../handlers/review.js";

export interface ReviewRouteDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
}

export function reviewRoutes(deps: ReviewRouteDeps): Hono {
  const app = new Hono();
  app.get("/tasks", (c) => listReviewTasks(c, deps));
  app.get("/clusters", (c) => listReviewClusters(c, deps));
  app.get("/clusters/:cluster_key/items", (c) => getClusterItems(c, deps));
  app.post("/clusters/:cluster_key/resolve", (c) => resolveReviewCluster(c, deps));
  app.post("/tasks/:id/edit-and-approve", (c) => editAndApproveTask(c, deps));
  app.patch("/tasks/:id", (c) => patchReviewTask(c, deps));
  app.post("/tasks/:id/reject", (c) => rejectReviewTask(c, deps));
  app.post("/tasks/:id/merge", (c) => mergeReviewTask(c, deps));
  app.get("/tasks/:id/evidence", (c) => getTaskEvidence(c, deps));
  return app;
}
