import type { ZodError } from "zod";

// The API contract keeps a stable envelope; issue codes/messages follow Zod.
export function validationErrorResponse(error: ZodError) {
  return { message: "Validation failed", issues: error.issues };
}
