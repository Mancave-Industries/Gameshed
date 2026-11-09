# Alfred Control Centre preview

Alfred runs on a dedicated Cloudflare Pages project. The publish directory is
public/ and the entry point is its advanced-mode Worker, _worker.js. Only the
review branch of this Pages project is in scope. It has its own D1 database and
uses the Pages preview alias as its canonical origin.

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
