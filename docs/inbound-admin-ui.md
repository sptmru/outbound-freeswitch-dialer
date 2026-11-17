# F05 — Inbound administration screens

Task: [F05 #33](https://github.com/sptmru/outbound-freeswitch-dialer/issues/33).
Base revision: `99a2373aadabb664ed0390da4b355d95d02b760d`.
Branch: `feat/f05-inbound-admin-ui`; changes are local and uncommitted.

Administrators open **Inbound routing** at `/inbound`. The existing authenticated
application shell and server authorization still apply. Agents cannot mount the
editor or mutate the F01 API. An active Agent Desk conversation retains the existing
navigation lock. No admission, media, provider or deployment bootstrap is added.

## Workflow

1. Create a **Queue**, choose its campaign, waiting audio, deadlines, maximum waiting
   calls and overflow policy. A queue's campaign is immutable after creation.
2. Create **Flows** with one to three ordered actions: play audio, forward externally,
   or hang up. There can be at most two audio actions and one forward action;
   hangup must be last and step bounds must fit the total timeout. The preview shows
   the ordered continuation; audio preview uses the existing scoped media ticket.
   Forwarding continues only on busy/no-answer/failure. Exhaustion ends the call.
3. Edit the queue to assign explicit no-answer and optional overflow flow versions.
   Saving a flow creates an immutable version and does not move queue assignments.
   Old assigned versions remain selectable as the unchanged retained reference.
4. Add a disabled **Number**, enter an international DID and select the shared queue.
   A second DID can select the same queue. Save enabled state explicitly. Disable
   and save before deleting. Server reference guards explain blocked deletion.
5. Use **Reload saved configuration** to inspect current application status. It
   discards the current draft. An edit conflict preserves the draft until this
   explicit reload; review and edit the latest saved revision before resubmitting.

Uploads use the existing WAV/MP3 library and decoder. **Upload inbound audio** always
sends `useForCampaign=false`; it cannot change outbound voicemail. The paged audio
library is loaded completely, and selections are filtered by campaign/readiness.
Missing/foreign/deleted audio and unsupported input remain server validation errors.
Preview authorization and media load failures are visible and allow a fresh preview.
No session tokens are placed in audio URLs by the UI.

## Save, apply and capacity semantics

Every create/edit/delete uses a UUID idempotency key and the captured expected revision.
Retries of the same draft retain the key after a lost/error response; edits receive a
new key. The client never silently rebases an edit after conflict. Saved collections
are reloaded after successful mutation because replay receipts can contain historical
application status. Late overlapping collection reads cannot overwrite newer reads.

Number/queue rows distinguish **Pending application**, **Applied to FreeSWITCH**,
and **Application failed**, including desired/applied revisions and the server error.
Disabled routes remain visibly disabled. A successful save does not purchase a DID,
prove delivery or activate provider routing. Apply failure retains D02 last-good routing;
this screen does not send ESL or bypass the publisher. Deployment-wide settings remain
in `.env` and runbooks.

Lower queue limits affect new admissions; admitted work and reservations remain intact.
Capacity rejection is `capacity_exceeded`, distinct from agent Ignore and ordinary
no-answer. Overflow flows require their own bounded resources and cannot bypass an
exhausted budget. The screen explains these consequences before saving. H03 owns the
expanded inbound history/reporting UI; F05 verifies the persisted rejection history
through the existing admission service and real PostgreSQL.

## Verification and proof boundaries

- `apps/web/src/features/inbound/inbound-admin.test.tsx`: role gate and finite-form
  validation (U).
- `tests/e2e/inbound-admin.spec.ts`, `playwright.f05.config.ts`: Chromium CRUD/reload,
  two shared-queue DIDs, agent gate, audio/forward/combined forms, keyboard controls,
  bounds/missing assets/invalid number messages, failed upload/preview, decoded WAV,
  pending/applied/error recovery, retained conflict draft/retry identity, and queue
  limit/overflow feedback (B). These are stateful HTTP fixtures, not a real API server.
- `apps/api/src/inbound-admin.integration.test.ts`: F05.4 uses the real authenticated
  admin API to lower a queue limit below two admitted calls, compares calls and
  reservations unchanged, imports new ingress and asserts terminal capacity rejection
  without offers/operations/permits, then proves cleanup and subsequent admission.
  Existing F01/F02 suites verify API role/CSRF/revision validation and real audio decoding.
  The admission fixture does not send ESL or establish a browser conversation.

Use Node 22 and ensure `ffmpeg`/`ffprobe` are on PATH for decoder regressions:

```bash
npm --workspace @outbound-dialer/web test -- src/features/inbound/inbound-admin.test.tsx
npm run test:inbound:admin:browser
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run quality
git diff --check
```

The browser runner uses an isolated Vite entry on localhost port 4176 and retains
failure traces/screenshots in `/tmp/f05-browser-results`; a successful preview screenshot
is `/tmp/f05-queue-preview.png`. These are local fixtures. Tmpfs database success does
not prove target-storage durability/performance. Actual commands, counts, artifacts and
failed attempts are recorded in the issue completion report. Provider acceptance,
real browser/API/FreeSWITCH journeys, deployment, load, rollback and I01–I05 activation
remain separate gates. No new runtime telephony claim is made by F05.
