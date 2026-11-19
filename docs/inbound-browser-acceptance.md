# I01 integrated browser acceptance

Run the matrix with Node.js 22.13 or newer, the Playwright-managed Chromium
build, and Docker with the repository-pinned PostgreSQL image available.

```bash
npx playwright install chromium
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:browser:isolated
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:browser:isolated -- --grep 'I01.2'
```

The runner creates a network-disabled PostgreSQL container with a Unix socket
and prints the artifact directory. Fastify uses an ephemeral loopback port, Vite
uses loopback port 4183, and each scenario uses its own migrated schema and
browser contexts. Failed Chromium tests retain screenshots and traces in the
artifact directory. Traces contain fixture cookies and media tickets and should
remain local.

Chromium runs the application entry point and uses real login, cookie
authorization, API routes, and PostgreSQL persistence. The test server supplies
the staged Desk coordination projection and executor wake adapters. It injects
synthetic ingress records and media effects at the connection and rebridge
boundaries. Offer/transfer mutations, slot arbitration, expiry, owner checks,
terminal history, configuration validation and media ticket authorization use
product code. Browser SSE uses the product endpoint with fixture-published
refresh hints. The polling test blocks SSE and advances Chromium's clock. Offer
and transfer expiry use the PostgreSQL deadlines. The suite supplies a fake
registered phone and silent WAVs.

| Criterion | Browser and database checks                                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01.1     | Ring-all with competing browser Accepts, a single persisted winner and attempt, refresh in a second tab, connection and terminal history, Ignore and timeout exclusions, all agents busy, newly eligible agents, campaign-specific eligibility, polling after loss of SSE, rejected and successful manual override, and auto-next deferral followed by explicit Next.             |
| I01.2     | Inbound and outbound transfer completion, decline, source cancellation, deadline expiry, recipient connection failure, and recipient manual outbound. Assert persisted transfer state and call ownership, check the former owner is denied after handover, and persist a hangup operation for the new owner.                                                                      |
| I01.3     | Admin saves a versioned flow, queue limits, audio assignment and a DID, previews audio through an authorized ticket, recovers from invalid input and reloads saved configuration and injected apply failure. Admin history shows the inbound journey and plays a secured recording, CSV contains the real call ID, and an agent is denied the history and playback-ticket routes. |
| I01.4     | Real API/DB manual-number, specific-lead and next-lead admission, pause/resume and active-call reload. Run the supplements below for active-call navigation, voicemail, supervisor modes and ringback.                                                                                                                                                                            |

## Supplements

- `npm run build && npm run test:e2e` runs built-browser coverage for navigation,
  reload, Desk lifecycle, voicemail controls, and recording export with routed
  API fixtures.
- `npm run test:desk:offers:browser`, `npm run test:desk:transfers:browser`,
  `npm run test:inbound:admin:browser`, and `npm run test:history:browser`
  exercise focused browser behavior with controlled HTTP and media fixtures.
- `npm run test:cleanup:freeswitch` and `npm run test:supervisor:freeswitch`
  exercise real local FreeSWITCH lifecycle and supervisor audio with isolated
  SIP/RTP endpoints. `npm run test:voicemail:db` covers campaign recording and
  voicemail assignment transactions.
- `npm run quality` covers static checks, tests, builds and the Web Audio ringback
  controller. Set `TEST_DATABASE_URL` to an isolated database for DB-backed API
  regression coverage.

I02 owns the pinned-FreeSWITCH acceptance matrix. I04 owns target-provider
acceptance. I05 owns production bootstrap, drain, rollback and enablement.
