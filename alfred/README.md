# Alfred Control Centre preview

Alfred runs on a dedicated Cloudflare Pages project. The publish directory is
public/ and the entry point is its advanced-mode Worker, _worker.js. Only the
review branch of this Pages project is in scope. It has its own D1 database and
uses the Pages preview alias as its canonical origin.

## Deployment is manual

Pushes and merges never deploy Alfred. To publish the review deployment, open
Actions → Alfred preview → Run workflow, choose the branch and type
`DEPLOY PREVIEW`. Anything else skips the job.

## The workspace

The page is a single mobile-first conversation built around the loop
REVIEW → RECOMMEND → APPROVE → EXECUTE → VERIFY → REPORT → REPEAT.

- **Happening now** lists approved, running, blocked and sent-back work.
- **Alfred's brief** shows results waiting for a check first, then the next
  decision. When one is settled, the next appears automatically. The page
  refreshes every minute while it is open.
- **Talking to Alfred.** Typed messages are understood in the browser at no
  cost: "what's next", "what's happening", "recent results", a project name,
  "yes" or "go with option 2" (Alfred asks for one tap to confirm; typing
  alone never records anything), "later", "looks right", and "no" or
  "something's wrong" followed by a note. Anything else offers "Ask Claude",
  which uses the existing capped Ask Alfred budget only when tapped.
- **☰** opens workflow history, projects with their earlier YES/NO/DEFER
  decisions (still changeable), and Claude pilot and rehearsal activity.

`GET /api/workspace` returns everything the page needs in one read.
`POST /api/workflows/{n}/verify` records a check:
`{"verdict":"verified"}` or `{"verdict":"verification_failed","note":"…"}`.

## Workflow event protocol

Workflow issues in Gameshed start with `<!-- alfred-workflow:v1 -->`. Events
are owner-authored comments starting with `<!-- alfred-workflow-event:v1 -->`,
applied in comment-ID order. The first five event types are unchanged, so
the existing scheduled executor keeps working.

| Event | From → to |
| --- | --- |
| `choice` (option, label, detail) | decision/deferred → queued |
| `choice` with option `defer` | decision → deferred |
| `started` | queued, blocked or verification_failed → running |
| `completed` / `blocked` (result) | running/blocked → completed/blocked |
| `verifying` | completed → verifying |
| `verified` (optional result, `by`) | completed/verifying → verified |
| `verification_failed` (result, `by`) | completed/verifying → verification_failed |

The verification events are new and additive: an executor that does not know
them ignores them. The owner records them from the workspace with `"by":"owner"`.
A future executor can post its own `verifying`/`verified` events, and can
restart work that was sent back by posting `started` again for the same
decision.

## Tests

`cd alfred && npm test` runs the real Worker offline, with an in-memory D1
database and a fake GitHub seeded from the live Gameshed workflow records. Any
other outbound request fails the test, so no GitHub writes, Cloudflare calls
or Anthropic charges are possible. Browser tests drive the page on an emulated
iPhone 13 when Playwright is installed, and are skipped otherwise. Set
`ALFRED_SCREENSHOTS=<dir>` to save screenshots.

## Preview configuration

Use a new Direct Upload project with production branch main. Deploy public/ to
the review branch with Wrangler. Keep the production branch empty and use the
returned review alias without a custom domain.

The preview environment needs these bindings.

| Binding | Value |
| --- | --- |
| ALFRED_ORIGIN | Exact HTTPS preview alias origin, without a trailing slash |
| ALFRED_DB | Dedicated preview D1 database initialised with schema.sql |
| GITHUB_APP_CLIENT_ID | Client ID of the preview GitHub App |
| GITHUB_APP_CLIENT_SECRET | GitHub App client secret, encrypted Cloudflare secret |
| ALFRED_SESSION_KEY | Random 32 bytes encoded as unpadded base64url, encrypted Cloudflare secret |
| ALFRED_DECISION_ISSUES | JSON object mapping the four decision keys below to the corresponding issue numbers |

Open /setup/github on the canonical preview to register and install the private
GitHub App. GitHub returns credentials to Alfred through the setup callback, and
Alfred encrypts them in the preview D1 database. The environment bindings can
also supply credentials directly. The app belongs to Mancave-Industries. Its user callback is
ALFRED_ORIGIN followed by /auth/callback. Enable expiring user tokens and
disable webhooks. Install on just the four repositories below with Metadata
read, Pull requests read and Issues read/write. The preview checks the
GitHub account's numeric ID, uses state and PKCE, and stores encrypted user
tokens in D1. The browser only receives an opaque HTTP-only session cookie.

## Decision records

Use one dedicated open issue in each project repository. Start the issue body
with the matching HTML marker on its own line. Alfred verifies the marker
before updating the issue, and the issue's edit history preserves previous
answers. YES, NO and DEFER update the same record.

| Decision key | Repository | Issue marker |
| --- | --- | --- |
| deceivers-audit | Deceivers | `<!-- alfred-decision:deceivers-audit:v1 -->` |
| science-mvp | Science_Budy | `<!-- alfred-decision:science-mvp:v1 -->` |
| mci-freeze | MANCAVE-INDUSTRIES.github.io | `<!-- alfred-decision:mci-freeze:v1 -->` |
| songbook-hold | risk-assessment-songbook | `<!-- alfred-decision:songbook-hold:v1 -->` |

## Claude handoff

Alfred's /handoff page provides a £0 rehearsal for an open Deceivers issue.
The owner reviews the issue and approves once. The worker verifies the issue
revision again and atomically consumes the expiring proposal. The rehearsal
stores approval evidence in D1. It makes zero Claude calls.


[Deceivers PR #4](https://github.com/Mancave-Industries/Deceivers/pull/4)
contains the inactive design and a workflow example in docs/. The example
requires a one-use verifier for a named run, its exact scope, cost ceiling
and expiry. A future handoff can pass a GitHub issue number and approved run
ID to that workflow, then read the evidence and draft PR back from GitHub.
Activation and each chargeable run require separate approval. The preview app
has permissions for GitHub reads and issue writes only.
