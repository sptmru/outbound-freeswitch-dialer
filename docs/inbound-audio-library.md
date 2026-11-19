# Inbound audio library and reference lifetime (F02)

F02 reuses campaign-owned `recordings`, the existing WAV/MP3 processor and storage,
and the administrator preview/media-ticket routes. It does not enable inbound
routing or implement F03 no-answer execution. A stored asset is not provider
playback evidence.

## Upload, assignment and preview

Use `POST /admin/recordings` with multipart `campaignId`, optional `name` and
`useForCampaign=false` **before** the file part. Only administrators can upload or
manage audio. A recording belongs to exactly one campaign; global/legacy unowned
assets are unavailable for new assignments. The single-tenant administrator can
preview owned audio across campaigns; agents cannot use the administrator library.

The existing `VOICEMAIL_UPLOAD_MAX_BYTES` limit applies equally to inbound audio
(default 64 MiB); no separate storage tree, decoder or global default is introduced.
File extensions are WAV/MP3, case-insensitive, and ffprobe must identify WAV/MP3
content. Empty, malformed, unsupported, oversized/truncated and over-five-minute
uploads fail without a recording row or leftover temporary/canonical upload files.
FFmpeg/ffprobe cannot use network protocols and have 60/15-second process bounds.
A missing processor returns 503. Successful conversion retains the existing mono
8 kHz PCM s16le WAV and loudness normalization. Storage paths remain UUID-derived.

For inbound-only audio leave `useForCampaign` false. Select its ID through:

- `POST/PATCH /admin/inbound-queues`: `waitingRecordingId`, nullable to select the
  existing waiting tone for **future** captures.
- `POST/PATCH /admin/inbound-flows`: `definition.actions[].recordingId` on a
  bounded `play_audio` action. The complete duration must fit `timeoutMs`; the
  action bound is 60 seconds even though the shared upload limit is five minutes.

These F01 operations retain `Idempotency-Key`, `expectedRevision`, campaign
ownership and immutable version validation. `campaigns.voicemail_recording_id`
changes only through explicit outbound assignment (or `useForCampaign=true`).
The library's existing `isAssigned`/`status=assigned` describe that **outbound**
assignment, not whether inbound references permit deletion. F05 owns the inbound
administration screens.

`POST /admin/recordings/:recordingId/audio-ticket` and
`GET /admin/recordings/:recordingId/audio` preview the same canonical bytes. Admin
sessions or matching hashed user/resource tickets authorize streaming; an active
administrator, idle expiry and absolute lifetime are rechecked. Tickets for another
resource, expired tickets and revoked users cannot access audio. Valid single byte
ranges return 206 with real bytes; invalid ranges return 416. Ticket scope remains
`voicemail_recording` for compatibility; it is the shared library asset scope.

## Replacement, disable and deletion

Upload a new asset, then save a new queue assignment/flow version. Never overwrite
the old asset in place. Previously captured ingress, executing waiting operations
and immutable flow versions retain the original IDs/paths/parameters. Subsequent
calls use the newly published route. Saving configuration alone does not establish
FreeSWITCH application; D02 still verifies the loaded revision.

Disabling a DID, clearing a waiting assignment or disabling/tombstoning an
unreferenced flow does not release historical media references. `DELETE
/admin/recordings/:recordingId` returns 409 while any of these apply:

- The campaign's outbound assignment, active outbound call or unresolved operation
  associated with that call's saved recording.
- A current queue waiting assignment or **any retained immutable flow version**.
- A published ingress route snapshot, including an old or unsuccessfully applied
  revision that may still have an unimported FS-local journal capture.
- Captured ingress without an acknowledged terminal sequence, or a queue
  admission with a live leg or unresolved work. A native terminal event alone
  leaves the asset pinned until the journal and call are drained.

An unreferenced asset follows the existing soft-deactivate, commit, unlink policy.
An unlink error other than ENOENT restores only asset activity, never a campaign
assignment/global default. There is no API to force-delete a referenced asset.
H04 owns explicit drained archival/retention; pins are deliberately conservative
and never expire on a timer. Never manually unlink a pinned file.

Migration `041_inbound_audio_references.sql` adds a generated, indexed,
campaign-owned waiting-asset FK on `inbound_ingress_route_snapshots`. Snapshot
insertion takes a recording SHARE lock and validates activity/ownership before the
publisher can expose the route. A database trigger also rejects soft-deactivation
of this pinned asset by the immediately previous deletion writer, before filesystem
unlink. This is fail-closed compatibility, not a full rollback-binary drill.
Populated upgrades and replay preserve predecessor checksums and snapshots; a
preexisting broken ownership/FK fails migration rather than inventing a replacement.

Deletion takes configuration lock `(72204,0)` before the admission and campaign
voicemail locks and recording row lock. It rechecks references after waiting. F01
writers/publisher use configuration-first ordering; call admission never acquires
that configuration lock. No transaction spans decoder, filesystem or ESL work.

## Verification

Requires Node >=22.13, Docker and the cached pinned images. Set `FFMPEG_PATH` and
`FFPROBE_PATH` if the existing tools are not on PATH. The dedicated F02 DB execution
fails if decoders are absent; it never silently skips their proof.

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=F02 npm run test:inbound:db:isolated
npm run test:audio:freeswitch
npm run test:voicemail:db
npm run quality
git diff --check
```

`inbound-audio.integration.test.ts` supplies real decoder/API normalization,
negative upload/preview authorization, replacement/version separation, pre-import
pins, uncertainty and unreferenced cleanup. Independent PostgreSQL backends,
explicit commit checkpoints and `pg_blocking_pids` prove reference/delete in both
orders, leading rollback, published snapshot/delete and admission/delete schedules.
A populated 040→041 fixture verifies migration replay and the older soft-delete
writer guard. Synthetic terminal operation updates are labeled as fixtures.

`test:audio:freeswitch` extends the existing disposable D04 product-entrypoint
runner with two F02 scenarios. An actual inbound SIP customer receives canonical
WAV waiting audio through the injected D04/C03 coordinator. Concurrent queue/flow
replacement and deletion retain the old file; decoded PCMU before and after the
edit retains its 660 Hz signal. The next call receives the new 880 Hz file. Native
terminal events, durable operation resolution, empty capacity/slot/channel/journal
state and cleanup are checked by the full D04 regression matrix. Reports, source
hashes and SIP/decoded-media evidence stay under `/tmp/outbound-d04.*`.

This is local isolated UDP/SIP/RTP proof. It does not establish F03 fallback-step
execution, F04 forwarding, browser WebRTC, provider/far-end delivery, target-storage
power-loss durability, load/soak, hosted CI, deployment/rollback or production
acceptance. I04/I05 and default-disabled activation remain separate. Actual commands,
results and artifact directories are recorded in GitHub issue #30.
