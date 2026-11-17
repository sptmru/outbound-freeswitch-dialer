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
// All B05 operations now have mounted handlers. Runtime activation is still I05.
export const plannedCallCoordinationOperations: ContractOperation[] = [];

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
