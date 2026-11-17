import { apiFetch } from "../../api";
import type {
  InboundNumbersResponse,
  InboundQueuesResponse,
  InboundFlowsResponse,
  SaveInboundNumberRequest,
  SaveInboundQueueRequest,
  SaveInboundFlowRequest,
  InboundNumberSnapshot,
  InboundQueueSnapshot,
  InboundFlowSnapshot,
  InboundAdminMutation
} from "@outbound-dialer/shared";

export type Resources = {
  numbers: { request: SaveInboundNumberRequest; snapshot: InboundNumberSnapshot };
  queues: { request: SaveInboundQueueRequest; snapshot: InboundQueueSnapshot };
  flows: { request: SaveInboundFlowRequest; snapshot: InboundFlowSnapshot };
};
export async function loadInbound() {
  const [numbers, queues, flows] = await Promise.all([
    apiFetch<InboundNumbersResponse>("/admin/inbound-numbers"),
    apiFetch<InboundQueuesResponse>("/admin/inbound-queues"),
    apiFetch<InboundFlowsResponse>("/admin/inbound-flows")
  ]);
  return { numbers: numbers.items, queues: queues.items, flows: flows.items };
}
export function saveInbound<K extends keyof Resources>(
  kind: K,
  id: string | null,
  body: Resources[K]["request"]
) {
  return apiFetch<Resources[K]["snapshot"]>(
    `/admin/inbound-${kind}${id ? `/${encodeURIComponent(id)}` : ""}`,
    {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(body)
    }
  );
}
export function deleteInbound(kind: keyof Resources, id: string, body: InboundAdminMutation) {
  return apiFetch<{ ok: true }>(`/admin/inbound-${kind}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify(body)
  });
}
