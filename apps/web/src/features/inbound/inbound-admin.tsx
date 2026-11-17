import {
  useEffect,
  useRef,
  useState,
  useId,
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type ReactElement,
  type FormEvent,
  type ReactNode
} from "react";
import type {
  InboundAppliedState,
  InboundFlowAction,
  InboundFlowDefinition,
  InboundQueueConfiguration
} from "@outbound-dialer/shared";
import type { AdminOverviewResponse, PublicUser } from "../../types";
import { ApiError, fetchAdminRecordings, getRecordingAudioUrl } from "../../api";
import { VoicemailUpload } from "../recordings/voicemail-upload";
import { deleteInbound, loadInbound, saveInbound, type Resources } from "./inbound-api";

export const queueDefaults: InboundQueueConfiguration = {
  offerTimeoutMs: 15000,
  queueTimeoutMs: 60000,
  connectTimeoutMs: 10000,
  transferTimeoutMs: 20000,
  maxWaitingCalls: 40,
  overflowPolicy: "reject",
  overflowFlowVersionId: null
};
export function flowError(definition: InboundFlowDefinition): string | null {
  const a = definition.actions;
  if (!a.length || a.length > 3) return "Choose one to three steps.";
  if (a.some((v, i) => v.type === "hangup" && i !== a.length - 1)) return "Hangup must be the last step.";
  if (
    a.filter((v) => v.type === "play_audio").length > 2 ||
    a.filter((v) => v.type === "forward_external").length > 1
  )
    return "Use at most two audio steps and one forwarding step.";
  if (a.some((v) => v.type === "play_audio" && !v.recordingId))
    return "Choose audio for every playback step.";
  if (a.some((v) => v.type === "forward_external" && !v.target.trim()))
    return "Enter an international forwarding number.";
  if (a.reduce((sum, v) => sum + (v.type === "hangup" ? 0 : v.timeoutMs), 0) > definition.flowTimeoutMs)
    return "Step timeouts exceed the total flow timeout.";
  return null;
}
function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const issues = (error.body as { issues?: Array<{ message: string }> })?.issues;
    if (issues?.length) return issues.map((v) => v.message).join("; ");
    const code = (error.body as { code?: string })?.code ?? error.message;
    const messages: Record<string, string> = {
      revision_conflict:
        "This configuration changed elsewhere. Your draft is preserved. Reload saved configuration, then review and edit again.",
      configuration_in_use:
        "This item is still referenced. Remove its assignments before disabling or deleting it.",
      disable_before_delete: "Save this number as disabled before deleting it.",
      audio_unavailable: "The selected audio is missing, unavailable or belongs to another campaign.",
      flow_unavailable: "The selected flow version is unavailable. Choose an enabled flow for this campaign.",
      owned_did_forwarding_loop:
        "Forwarding cannot target a saved inbound number, including a disabled number.",
      duplicate_configuration: "This inbound number is already configured.",
      invalid_configuration: "Check international numbers, audio duration, step order and timeout limits.",
      capacity_exceeded:
        "Capacity reached. Existing calls are preserved; this is not agent Ignore or ordinary no-answer."
    };
    return messages[code] ?? error.message;
  }
  return error instanceof Error ? error.message : "Could not save configuration.";
}
function Applied({ value }: { value: InboundAppliedState }) {
  return (
    <p className="inbound-application" role="status">
      {value.status === "applied"
        ? "Applied to FreeSWITCH"
        : value.status === "error"
          ? "Application failed"
          : "Pending application"}
      {` · desired ${value.desiredRevision} · applied ${value.appliedRevision ?? "none"}`}
      {value.error && <strong> — {value.error}</strong>}
    </p>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  function bind(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<{ id?: string; children?: ReactNode }>;
      if (node.type === Fragment) return cloneElement(element, {}, bind(element.props.children));
      return node.type === "input" || node.type === "select" ? cloneElement(element, { id }) : node;
    });
  }
  return (
    <div className="inbound-field">
      <label htmlFor={id}>{label}</label>
      {bind(children)}
    </div>
  );
}

type Data = Awaited<ReturnType<typeof loadInbound>>;
type Kind = keyof Resources;
type NumberDraft = Omit<Resources["numbers"]["request"], "idempotencyKey" | "expectedRevision">;
type QueueDraft = Omit<Resources["queues"]["request"], "idempotencyKey" | "expectedRevision">;
type FlowDraft = Omit<Resources["flows"]["request"], "idempotencyKey" | "expectedRevision">;
const newNumber = (): NumberDraft => ({ label: "", did: "", queueId: "", enabled: false });
const newQueue = (campaignId = ""): QueueDraft => ({
  name: "",
  campaignId,
  waitingRecordingId: null,
  noAnswerFlowVersionId: null,
  configuration: { ...queueDefaults }
});
const newFlow = (campaignId = ""): FlowDraft => ({
  name: "",
  campaignId,
  enabled: true,
  definition: { flowTimeoutMs: 90000, actions: [{ type: "hangup" }] }
});

export function InboundAdmin(props: {
  admin: AdminOverviewResponse;
  role: PublicUser["role"];
  onChanged: () => Promise<void>;
}) {
  return props.role === "admin" ? <InboundEditor {...props} /> : <p>Admin access required</p>;
}
function InboundEditor({
  admin,
  onChanged
}: {
  admin: AdminOverviewResponse;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<Data>({ numbers: [], queues: [], flows: [] });
  const [kind, setKind] = useState<Kind>("numbers");
  const [selected, setSelected] = useState<{ id: string; revision: string } | null>(null);
  const [number, setNumber] = useState(newNumber);
  const [queue, setQueue] = useState(() => newQueue());
  const [flow, setFlow] = useState(() => newFlow());
  const [recordings, setRecordings] = useState(admin.recordings);
  const [upload, setUpload] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const previewSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // Retain the exact request key after ambiguous responses. Edited payloads get a new key.
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const sequence = useRef(0);
  async function refresh() {
    const seq = ++sequence.current;
    const next = await loadInbound();
    if (seq === sequence.current) {
      setData(next);
      setLoaded(true);
    }
  }
  async function refreshAudio() {
    const items: typeof recordings = [];
    for (let page = 1; ; page++) {
      const result = await fetchAdminRecordings({ page, pageSize: 100 });
      items.push(...result.items);
      if (page >= result.totalPages) break;
    }
    setRecordings(items);
  }
  useEffect(() => {
    void Promise.all([refresh(), refreshAudio()]).catch((e) => setError(errorMessage(e)));
    return () => {
      sequence.current++;
      previewSequence.current++;
    };
  }, []);
  function reset(nextKind = kind) {
    setKind(nextKind);
    setSelected(null);
    setNumber(newNumber());
    setQueue(newQueue());
    setFlow(newFlow());
    setError(null);
    setNotice("");
    setPreview(null);
    previewSequence.current++;
    receipt.current = null;
  }
  function edit(id: string) {
    const item = data[kind].find((v) => v.id === id);
    if (!item) return;
    setSelected({ id: item.id, revision: item.revision });
    if (kind === "numbers") {
      const v = data.numbers.find((v) => v.id === id)!;
      setNumber({ label: v.label, did: v.did, queueId: v.queueId, enabled: v.enabled });
    } else if (kind === "queues") {
      const v = data.queues.find((v) => v.id === id)!;
      setQueue({
        name: v.name,
        campaignId: v.campaignId,
        waitingRecordingId: v.waitingRecordingId,
        noAnswerFlowVersionId: v.noAnswerFlowVersionId,
        configuration: { ...v.configuration }
      });
    } else {
      const v = data.flows.find((v) => v.id === id)!;
      setFlow({
        name: v.name,
        campaignId: v.campaignId,
        enabled: v.enabled,
        definition: structuredClone(v.definition)
      });
    }
    setError(null);
    setNotice("");
    receipt.current = null;
  }
  async function mutate(remove = false) {
    if (busy || !loaded) return;
    const draft = kind === "numbers" ? number : kind === "queues" ? queue : flow;
    const fingerprint = JSON.stringify([kind, selected, remove, draft]);
    if (receipt.current?.fingerprint !== fingerprint)
      receipt.current = { fingerprint, key: crypto.randomUUID() };
    const mutation = { idempotencyKey: receipt.current.key, expectedRevision: selected?.revision ?? null };
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      if (remove && selected) await deleteInbound(kind, selected.id, mutation);
      else if (kind === "numbers") await saveInbound(kind, selected?.id ?? null, { ...number, ...mutation });
      else if (kind === "queues") await saveInbound(kind, selected?.id ?? null, { ...queue, ...mutation });
      else await saveInbound(kind, selected?.id ?? null, { ...flow, ...mutation });
      // Never infer application from a mutation response or a historical replay receipt.
      reset();
      setNotice(
        remove
          ? "Deleted from current configuration."
          : "Saved. Check application status below. Provider delivery is not verified here."
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (kind === "flows") {
      const e = flowError(flow.definition);
      if (e) {
        setError(e);
        return;
      }
    }
    if (kind === "queues" && queue.configuration.connectTimeoutMs >= queue.configuration.queueTimeoutMs) {
      setError("Connect timeout must precede the queue deadline.");
      return;
    }
    void mutate();
  }
  async function play(id: string) {
    const seq = ++previewSequence.current;
    setPreview(null);
    setError(null);
    try {
      const url = await getRecordingAudioUrl(id);
      if (seq === previewSequence.current) setPreview(url);
    } catch (e) {
      if (seq === previewSequence.current) setError(errorMessage(e));
    }
  }
  const campaignId = kind === "queues" ? queue.campaignId : flow.campaignId;
  const audioOptions = recordings.filter((v) => v.campaignId === campaignId && v.status === "ready");
  const availableFlows = data.flows.filter((v) => v.campaignId === campaignId && v.enabled);
  function audioSelect(value: string | null, change: (id: string | null) => void, required = false) {
    return (
      <>
        <select required={required} value={value ?? ""} onChange={(e) => change(e.target.value || null)}>
          <option value="">{required ? "Choose audio" : "No waiting audio"}</option>
          {value && !audioOptions.some((v) => v.id === value) && (
            <option value={value}>Unavailable audio — choose a replacement</option>
          )}
          {audioOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.durationSeconds ?? "?"} sec)
            </option>
          ))}
        </select>
        <button type="button" disabled={!value} onClick={() => value && void play(value)}>
          Preview audio
        </button>
      </>
    );
  }
  function flowSelect(value: string | null, change: (id: string | null) => void, required = false) {
    return (
      <select required={required} value={value ?? ""} onChange={(e) => change(e.target.value || null)}>
        <option value="">{required ? "Choose a flow" : "Hang up without a flow"}</option>
        {value && !availableFlows.some((v) => v.versionId === value) && (
          <option value={value}>Retained version {value} (unchanged)</option>
        )}
        {availableFlows.map((v) => (
          <option key={v.versionId} value={v.versionId}>
            {v.name} · version {v.revision}
          </option>
        ))}
      </select>
    );
  }
  function setAction(index: number, action: InboundFlowAction) {
    setFlow({
      ...flow,
      definition: {
        ...flow.definition,
        actions: flow.definition.actions.map((v, i) => (i === index ? action : v))
      }
    });
  }
  const current = selected ? data[kind].find((v) => v.id === selected.id) : null;
  return (
    <div className="inbound-admin">
      <header className="surface-heading">
        <h2>Inbound routing</h2>
        <p>
          Configure numbers, a shared queue and no-answer handling. Saving does not purchase or activate a
          provider DID.
        </p>
      </header>
      <div className="inbound-toolbar">
        {(["numbers", "queues", "flows"] as const).map((v) => (
          <button type="button" key={v} aria-pressed={kind === v} disabled={busy} onClick={() => reset(v)}>
            {v === "numbers" ? "Numbers" : v === "queues" ? "Queues" : "Flows"}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            reset();
            void refresh().catch((e) => setError(errorMessage(e)));
          }}
        >
          Reload saved configuration
        </button>
        <button type="button" disabled={busy} onClick={() => setUpload(!upload)}>
          Upload inbound audio
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {upload && (
        <section className="panel">
          <h3>Inbound audio library</h3>
          <p>Uploads do not change outbound voicemail assignments.</p>
          <VoicemailUpload
            inbound
            campaigns={admin.campaigns}
            onCancel={() => setUpload(false)}
            onUploaded={async () => {
              await refreshAudio();
              await onChanged();
              setUpload(false);
            }}
          />
        </section>
      )}
      {preview && (
        <audio
          aria-label="Inbound audio preview"
          controls
          autoPlay
          src={preview}
          onError={() => {
            setError("Audio preview failed. Request a new preview or replace the audio.");
            setPreview(null);
          }}
        />
      )}
      <div className="inbound-layout">
        <section className="panel">
          <h3>Saved {kind}</h3>
          {!loaded && <p>Loading configuration…</p>}
          {loaded && !data[kind].length && <p>No {kind} configured.</p>}
          {data[kind].map((item) => (
            <article className="inbound-item" key={item.id}>
              <button disabled={busy} type="button" onClick={() => edit(item.id)}>
                {"label" in item ? `${item.label} · ${item.did}` : item.name}
              </button>
              {"enabled" in item && <span>{item.enabled ? "Enabled in configuration" : "Disabled"}</span>}
              {"apply" in item ? (
                <Applied value={item.apply} />
              ) : (
                <p>Version {item.revision} · assign this version to a queue to use it.</p>
              )}
            </article>
          ))}
        </section>
        <section className="panel">
          <h3>
            {selected ? "Edit" : "Add"} {kind === "numbers" ? "number" : kind === "queues" ? "queue" : "flow"}
          </h3>
          {selected && <p>Editing revision {selected.revision}</p>}
          <form className="stack-form" onSubmit={submit}>
            <fieldset disabled={busy || !loaded}>
              {kind === "numbers" ? (
                <>
                  <Field label="Number label">
                    <input
                      required
                      maxLength={160}
                      value={number.label}
                      onChange={(e) => setNumber({ ...number, label: e.target.value })}
                    />
                  </Field>
                  <Field label="International DID">
                    <input
                      required
                      type="tel"
                      placeholder="+1 (415) 555-0100"
                      value={number.did}
                      onChange={(e) => setNumber({ ...number, did: e.target.value })}
                    />
                  </Field>
                  <Field label="Shared queue">
                    <select
                      required
                      value={number.queueId}
                      onChange={(e) => setNumber({ ...number, queueId: e.target.value })}
                    >
                      <option value="">Choose a queue</option>
                      {data.queues.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Enabled in configuration">
                    <input
                      type="checkbox"
                      checked={number.enabled}
                      onChange={(e) => setNumber({ ...number, enabled: e.target.checked })}
                    />
                  </Field>
                  <p>
                    Disable and save before deleting. Routing changes take effect only after successful
                    application.
                  </p>
                </>
              ) : (
                <>
                  <Field label="Name">
                    <input
                      required
                      maxLength={160}
                      value={kind === "queues" ? queue.name : flow.name}
                      onChange={(e) =>
                        kind === "queues"
                          ? setQueue({ ...queue, name: e.target.value })
                          : setFlow({ ...flow, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Campaign">
                    <select
                      required
                      disabled={!!selected}
                      value={campaignId}
                      onChange={(e) =>
                        kind === "queues"
                          ? setQueue({ ...newQueue(e.target.value), name: queue.name })
                          : setFlow({ ...newFlow(e.target.value), name: flow.name })
                      }
                    >
                      <option value="">Choose a campaign</option>
                      {admin.campaigns
                        .filter((v) => v.status !== "archived" || v.id === campaignId)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {kind === "queues" ? (
                    <>
                      <Field label="Waiting audio">
                        {audioSelect(queue.waitingRecordingId, (id) =>
                          setQueue({ ...queue, waitingRecordingId: id })
                        )}
                      </Field>
                      <Field label="No-answer flow">
                        {flowSelect(queue.noAnswerFlowVersionId, (id) =>
                          setQueue({ ...queue, noAnswerFlowVersionId: id })
                        )}
                      </Field>
                      {(
                        [
                          ["offerTimeoutMs", "Offer timeout (ms)", 5000, 30000],
                          ["queueTimeoutMs", "Queue timeout (ms)", 15000, 300000],
                          ["connectTimeoutMs", "Connect timeout (ms)", 6000, 15000],
                          ["transferTimeoutMs", "Transfer timeout (ms)", 5000, 30000],
                          ["maxWaitingCalls", "Maximum waiting calls", 1, 200]
                        ] as const
                      ).map(([key, label, min, max]) => (
                        <Field key={key} label={label}>
                          <input
                            required
                            type="number"
                            min={min}
                            max={max}
                            step={1}
                            value={queue.configuration[key]}
                            onChange={(e) =>
                              setQueue({
                                ...queue,
                                configuration: { ...queue.configuration, [key]: Number(e.target.value) }
                              })
                            }
                          />
                        </Field>
                      ))}
                      <Field label="Overflow policy">
                        <select
                          value={queue.configuration.overflowPolicy}
                          onChange={(e) =>
                            setQueue({
                              ...queue,
                              configuration: {
                                ...queue.configuration,
                                overflowPolicy: e.target.value as "reject" | "flow",
                                overflowFlowVersionId: null
                              }
                            })
                          }
                        >
                          <option value="reject">Reject new ingress</option>
                          <option value="flow">Run a bounded overflow flow</option>
                        </select>
                      </Field>
                      {queue.configuration.overflowPolicy === "flow" && (
                        <Field label="Overflow flow">
                          {flowSelect(
                            queue.configuration.overflowFlowVersionId,
                            (id) =>
                              setQueue({
                                ...queue,
                                configuration: { ...queue.configuration, overflowFlowVersionId: id }
                              }),
                            true
                          )}
                        </Field>
                      )}
                      <p>
                        Lower limits preserve admitted calls. New ingress can be rejected with
                        capacity_exceeded; this differs from agent Ignore and ordinary no-answer. Overflow
                        runs only with available reserved resources.
                      </p>
                    </>
                  ) : (
                    <>
                      <Field label="Flow enabled">
                        <input
                          type="checkbox"
                          checked={flow.enabled}
                          onChange={(e) => setFlow({ ...flow, enabled: e.target.checked })}
                        />
                      </Field>
                      <Field label="Total flow timeout (ms)">
                        <input
                          required
                          type="number"
                          min={1000}
                          max={180000}
                          value={flow.definition.flowTimeoutMs}
                          onChange={(e) =>
                            setFlow({
                              ...flow,
                              definition: { ...flow.definition, flowTimeoutMs: Number(e.target.value) }
                            })
                          }
                        />
                      </Field>
                      {flow.definition.actions.map((action, index) => (
                        <fieldset key={index}>
                          <legend>Step {index + 1}</legend>
                          <Field label={`Step ${index + 1} action`}>
                            <select
                              value={action.type}
                              onChange={(e) =>
                                setAction(
                                  index,
                                  e.target.value === "hangup"
                                    ? { type: "hangup" }
                                    : e.target.value === "play_audio"
                                      ? { type: "play_audio", recordingId: "", timeoutMs: 10000 }
                                      : { type: "forward_external", target: "", timeoutMs: 20000 }
                                )
                              }
                            >
                              <option value="play_audio">Play audio</option>
                              <option value="forward_external">Forward externally</option>
                              <option value="hangup">Hang up</option>
                            </select>
                          </Field>
                          {action.type === "play_audio" && (
                            <Field label={`Step ${index + 1} audio`}>
                              {audioSelect(
                                action.recordingId,
                                (id) => setAction(index, { ...action, recordingId: id ?? "" }),
                                true
                              )}
                            </Field>
                          )}
                          {action.type === "forward_external" && (
                            <Field label={`Step ${index + 1} international target`}>
                              <input
                                required
                                type="tel"
                                value={action.target}
                                onChange={(e) => setAction(index, { ...action, target: e.target.value })}
                              />
                            </Field>
                          )}
                          {action.type !== "hangup" && (
                            <Field label={`Step ${index + 1} timeout (ms)`}>
                              <input
                                required
                                type="number"
                                min={action.type === "play_audio" ? 1000 : 5000}
                                max={action.type === "play_audio" ? 60000 : 30000}
                                value={action.timeoutMs}
                                onChange={(e) =>
                                  setAction(index, { ...action, timeoutMs: Number(e.target.value) })
                                }
                              />
                            </Field>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setFlow({
                                ...flow,
                                definition: {
                                  ...flow.definition,
                                  actions: flow.definition.actions.filter((_, i) => i !== index)
                                }
                              })
                            }
                          >
                            Remove step {index + 1}
                          </button>
                        </fieldset>
                      ))}
                      <button
                        type="button"
                        disabled={flow.definition.actions.length >= 3}
                        onClick={() =>
                          setFlow({
                            ...flow,
                            definition: {
                              ...flow.definition,
                              actions: [...flow.definition.actions, { type: "hangup" }]
                            }
                          })
                        }
                      >
                        Add step
                      </button>
                      <p>
                        Flow preview:{" "}
                        {flow.definition.actions
                          .map((v) =>
                            v.type === "hangup"
                              ? "Hang up"
                              : v.type === "forward_external"
                                ? `Forward to ${v.target || "…"}`
                                : `Play ${recordings.find((r) => r.id === v.recordingId)?.name ?? "…"}`
                          )
                          .join(" → ")}
                        . Forwarding continues only on busy, no-answer or failure. Exhaustion hangs up.
                      </p>
                      <p>
                        Saving creates a new immutable version. Update queue assignments explicitly; running
                        calls keep their saved version.
                      </p>
                    </>
                  )}
                </>
              )}
              <div className="inbound-toolbar">
                <button className="primary-action" type="submit">
                  {busy ? "Saving…" : "Save configuration"}
                </button>
                <button type="button" onClick={() => reset()}>
                  New {kind === "numbers" ? "number" : kind === "queues" ? "queue" : "flow"}
                </button>
                {selected && (
                  <button
                    className="danger-action"
                    type="button"
                    disabled={kind === "numbers" && !!current && "enabled" in current && current.enabled}
                    onClick={() => {
                      if (window.confirm("Delete this configuration? Retained call history is preserved."))
                        void mutate(true);
                    }}
                  >
                    Delete configuration
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        </section>
      </div>
    </div>
  );
}
