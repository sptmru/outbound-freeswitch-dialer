import { createDeskSession, leaveDeskSession, updateDeskSession } from "./api";
import type {
  CreateDeskSessionRequest,
  DeskSessionResponse,
  DeskSessionSnapshot,
  SoftphoneProvisioningResponse,
  UpdateDeskSessionRequest
} from "./types";

export interface DeskControl {
  campaignId: string | null;
  expectedRevision: string | null;
}
const defaultApi = {
  create: ((input) => createDeskSession(input)) as typeof createDeskSession,
  update: ((input) => updateDeskSession(input)) as typeof updateDeskSession,
  leave: ((input) => leaveDeskSession(input)) as typeof leaveDeskSession
};
/** In-memory, serialized lifecycle. A new browser/Desk must claim its own identity.
 * HTTP/SSE and registration flags cannot attest readiness. Never releases media. */
export class DeskSessionController {
  private session: DeskSessionSnapshot | null = null;
  private closed = false;
  private registered = false;
  private pending: UpdateDeskSessionRequest | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private campaignId: string | null;
  private readonly createInput: CreateDeskSessionRequest;
  constructor(
    control: DeskControl,
    private readonly changed: (session: DeskSessionSnapshot | null) => void,
    private readonly api = defaultApi
  ) {
    this.campaignId = control.campaignId;
    this.createInput = { ...control, idempotencyKey: crypto.randomUUID() };
  }
  async start(): Promise<SoftphoneProvisioningResponse> {
    const result = await this.api.create(this.createInput);
    this.accept(result);
    if (this.closed) {
      await this.leave();
      throw new Error("Desk closed");
    }
    if (!result.session || !result.sip) throw new Error("Desk credentials are unavailable");
    const { username, password, domain, websocketUrl, iceServers } = result.sip;
    return {
      sipUri: `sip:${username}@${domain}`,
      sipUsername: username,
      sipPassword: password,
      domain,
      websocketUrl,
      iceServers,
      displayName: "Agent Desk"
    };
  }
  setRegistered(registered: boolean) {
    this.registered = registered;
  }
  selectCampaign(id: string | null) {
    this.campaignId = id;
  }
  heartbeat(): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.closed || !this.session) return;
      this.pending ??= {
        deskSessionId: this.session.id,
        expectedRevision: this.session.revision,
        bindingGeneration: this.session.bindingGeneration,
        idempotencyKey: crypto.randomUUID(),
        campaignId: this.campaignId,
        ready: this.registered
      };
      try {
        const response = await this.api.update(this.pending);
        this.pending = null;
        this.accept(response);
      } catch (error) {
        // Keep the exact request for ambiguous HTTP loss; never retry as a new mutation.
        if (!this.closed) this.changed({ ...this.session, ready: false, endpointVerified: false });
        // A definitive CAS rejection carries the authenticated current snapshot.
        // It is safe to issue a new key only after that rejection, never on HTTP loss.
        if (error && typeof error === "object" && "body" in error) {
          const body = error.body as { code?: string; session?: DeskSessionSnapshot };
          if (
            body?.code === "revision_conflict" &&
            body.session?.id === this.session.id &&
            body.session.bindingGeneration === this.session.bindingGeneration
          ) {
            this.session = body.session;
            this.pending = null;
          }
        }
        throw error;
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
  private accept(result: DeskSessionResponse) {
    this.session = result.session;
    if (!this.closed)
      this.changed(
        this.session && new Date(this.session.expiresAt).getTime() <= Date.now()
          ? { ...this.session, ready: false, endpointVerified: false }
          : this.session
      );
  }
  async close() {
    this.closed = true;
    this.changed(null);
    await this.chain;
    await this.leave();
  }
  private async leave() {
    if (!this.session) return;
    // Resolve an ambiguous heartbeat first so teardown uses its committed revision.
    if (this.pending) {
      try {
        this.accept(await this.api.update(this.pending));
        this.pending = null;
      } catch {
        return;
      }
    }
    if (!this.session) return;
    const s = this.session;
    await this.api
      .leave({
        deskSessionId: s.id,
        expectedRevision: s.revision,
        bindingGeneration: s.bindingGeneration,
        idempotencyKey: crypto.randomUUID()
      })
      .catch(() => {});
    this.session = null;
  }
}
