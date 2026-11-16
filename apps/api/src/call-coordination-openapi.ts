// B05 contract catalog only. These operations are not mounted by this module.
// Exposed separately from live paths, so generated clients cannot mistake them
// for implemented admission/dispatch/media/configuration handlers.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
type ContractOperation = {
  method: string;
  path: string;
  request?: string;
  response: string;
  role: "authenticated" | "admin";
};
export const plannedCallCoordinationOperations: ContractOperation[] = [
  {
    method: "post",
    path: "/agent/call-offers/{offerId}/accept",
    request: "DeskMutationRequest",
    response: "AcceptCallOfferResponse",
    role: "authenticated"
  },
  {
    method: "get",
    path: "/agent/calls/{callId}/transfer-targets",
    response: "TransferTargetsResponse",
    role: "authenticated"
  },
  {
    method: "post",
    path: "/agent/calls/{callId}/transfers",
    request: "CreateTransferRequest",
    response: "TransferSnapshot",
    role: "authenticated"
  },
  {
    method: "delete",
    path: "/agent/calls/{callId}/transfers/{transferId}",
    request: "DeskMutationRequest",
    response: "TransferSnapshot",
    role: "authenticated"
  }
];
for (const [collection, singular, save, list] of [
  ["inbound-numbers", "InboundNumberSnapshot", "SaveInboundNumberRequest", "InboundNumbersResponse"],
  ["inbound-queues", "InboundQueueSnapshot", "SaveInboundQueueRequest", "InboundQueuesResponse"],
  ["inbound-flows", "InboundFlowSnapshot", "SaveInboundFlowRequest", "InboundFlowsResponse"]
]) {
  plannedCallCoordinationOperations.push(
    { method: "get", path: `/admin/${collection}`, response: list, role: "admin" },
    { method: "post", path: `/admin/${collection}`, request: save, response: singular, role: "admin" },
    { method: "patch", path: `/admin/${collection}/{id}`, request: save, response: singular, role: "admin" },
    {
      method: "delete",
      path: `/admin/${collection}/{id}`,
      request: "InboundAdminMutation",
      response: "DeleteResponse",
      role: "admin"
    }
  );
}

export function plannedCallCoordinationCatalog() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of plannedCallCoordinationOperations) {
    const json = (schema: string) => ({ content: { "application/json": { schema: ref(schema) } } });
    const parameters = [...op.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" }
    }));
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      summary: `Planned ${op.method.toUpperCase()} ${op.path}`,
      description: "B05 contract only; implementation and enablement are separate backlog gates.",
      "x-required-role": op.role,
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      parameters,
      ...(op.request ? { requestBody: { required: true, ...json(op.request) } } : {}),
      responses: {
        "200": { description: "Committed result; connecting is not media proof", ...json(op.response) },
        ...Object.fromEntries(
          [400, 401, 403, 404].map((status) => [
            status,
            { description: "Validation or access rejected", ...json("ErrorResponse") }
          ])
        ),
        "409": {
          description: "Coordination conflict; refetch Desk without changing automatic intent to manual",
          ...json("CoordinationErrorResponse")
        }
      }
    };
  }
  return { contractVersion: 1, status: "contract-only", paths };
}
