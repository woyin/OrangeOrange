import { defineDoc } from "@earendil-works/pi-durable";
import type { Route } from "./channels/types.js";
export type Delivery = {
  id: string;
  routeKey: string;
  submissionId: number | null;
  parts: string[];
  part: number;
  remoteIds: string[];
  status:
    | "waiting"
    | "ready"
    | "sending"
    | "sent"
    | "unknown"
    | "failed"
    | "discarded";
  attempts: number;
  error: string;
  taskId: number;
  createdAt: number;
};
export const GatewayState = defineDoc<{
  routes: Record<string, Route>;
  deliveries: Record<string, Delivery>;
  cursors: Record<string, string>;
}>({
  kind: "orange.gateway",
  version: 1,
  scope: "session",
  initial: () => ({ routes: {}, deliveries: {}, cursors: {} }),
  checkpointWhen: (_v, _ops, info) => info.deltasSinceBase >= 50,
});
