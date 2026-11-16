import type { DeskSessionSnapshot, ServiceInviteRequest, ServiceInviteResponse } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface RequestHeaders {
  getHeader(name: string): string | undefined;
  getHeaders?(name: string): string[];
}
export function serviceInviteIdentity(
  request: RequestHeaders,
  session: DeskSessionSnapshot | null
): ServiceInviteRequest | null {
  const header = (name: string) => {
    const values = request.getHeaders?.(name);
    if (values && values.length !== 1) return "";
    return request.getHeader(name) ?? "";
  };
  const input = {
    callId: header("X-Outbound-Dialer-Call-ID"),
    operationId: header("X-Outbound-Dialer-Operation-ID"),
    deskSessionId: header("X-Outbound-Dialer-Desk-Session-ID"),
    bindingGeneration: header("X-Outbound-Dialer-Binding-Generation"),
    legUuid: header("X-Outbound-Dialer-Leg-ID"),
    dialogId: header("Call-ID")
  };
  if (
    !session ||
    ![input.callId, input.operationId, input.deskSessionId, input.legUuid].every((v) => uuid.test(v)) ||
    input.deskSessionId !== session.id ||
    input.bindingGeneration !== session.bindingGeneration ||
    !/^[1-9][0-9]{0,18}$/.test(input.bindingGeneration) ||
    BigInt(input.bindingGeneration) > 9223372036854775807n ||
    !/^[\x21-\x7e]{1,255}$/.test(input.dialogId)
  )
    return null;
  return input;
}
export function serviceInviteMatches(input: ServiceInviteRequest, response: ServiceInviteResponse): boolean {
  return (
    response.authorized === true &&
    (Object.keys(input) as Array<keyof ServiceInviteRequest>).every((k) => response[k] === input[k])
  );
}
