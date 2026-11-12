# Automatic execution: implementation and activation

This extends the existing Worker, D1 tables, GitHub issue protocol and mobile
workspace. It does not replace the interface or disable the existing review loop.

## What runs

An executable workflow option adds `execution` to its existing id/label/detail:

```json
{
  "repo": "Gameshed",
  "sha": "EXACT_40_CHARACTER_COMMIT_SHA",
  "paths": ["alfred/public/app.js"],
  "profile": "alfred-node",
  "maxMicrousd": 200000
}
```

The example SHA is a placeholder, not a runnable approval. The owner sees the
exact dollar ceiling on the existing Approve button. Each choice is a fresh grant
for one model request, never a standing budget. Historical proposals are immutable;
they are not retrofitted with spending permissions. Legacy options continue to
use the existing no-cost scheduled reviewer.

The Worker verifies the exact choice, saves an encrypted GitHub credential in a
D1 outbox keyed by the numeric decision comment ID, and the comment starts
`.github/workflows/alfred-execute.yml`. The runner claims the outbox row atomically.
It authenticates to Alfred using GitHub's audience-bound OIDC identity, pinned to
the reviewed repository, workflow path, revision and first run attempt.

The runner downloads that immutable repository archive from the gateway. It checks
the baseline in an isolated Docker container before spend, counts input tokens,
and calls the existing Claude Haiku API once. The full output allowance is reserved
at twice Haiku 4.5's standard $1/$5 per million input/output token prices. No tool,
cache, batch or retry surcharges are requested. Count failures or an insufficient
grant stop before inference. Provider billing remains in USD; no exchange-rate
promise is made. Pricing must be reviewed when changing the pinned model.

Claude receives only the approved text files (60 KB total, 20 paths maximum), not
credentials or the full archive. It returns complete edits to existing approved
files and a report. No model-generated shell command is run. The verifier runs
the baseline and candidate in a network-disabled, unprivileged, read-only Docker
container with no secrets or Docker socket. `alfred-node` runs the existing Worker
and execution tests from `alfred/`; `node-tests` runs Node's test discovery at the
repository root. Tasks needing other dependencies, media, a failing baseline or a
different verification plan stop explicitly; they are not falsely marked done.
`source-review` permits no file edits and verifies only source identity and report
shape, not the accuracy of the model's reasoning.

The gateway checks the run's signed evidence, output digest, unchanged approval
and GitHub read-back. It writes only `alfred/work-DECISION_ID`, never an existing
branch. It records started/checking/completed/verifying/verified, then publishes
one validated, deduplicated next decision. The model may suggest `action` equal to
`source-review` or `draft-change` for next options; Alfred confines these to the
same repository/files and the published SHA. They require another explicit cost
approval. Other recommendations are ordinary non-executable decisions.

The model's claim that it ran a test is never accepted as verification. Automated
checks do not establish scientific accuracy, physical-device behaviour or owner
acceptance. The signed runner reports only the checks actually executed.

## Recovery

The manual execution workflow also has a `startup-probe` mode. Supply an existing
numeric choice comment ID as `decision_id`. Its separate job receives no Anthropic
key. After normal pinned OIDC validation, it checks the saved credential, exact
approval, Actions read access and approved source. It reports only a phase code
or queue status, expiry and file count. It never claims or revives an approval,
writes events, returns source/credentials or calls a model. It can inspect an
expired blocked row without making that row runnable. Install the reviewed runner
revision on main and publish the matching preview activation before using it;
this needs the owner's merge/preview approval. Successful diagnostics are not
evidence that Claude execution succeeded and do not authorise a paid retry.

Competing runner claims and action reruns cannot consume a decision twice. Provider
timeouts are never retried. Result delivery can retry without calling Claude again;
deterministic review branches and idempotent status events prevent duplicate output.
Heartbeats keep active work visible. On refresh, queued work with no runner after
10 minutes, or active work silent for 20 minutes, becomes blocked with a remedy.
A paid interrupted run needs review and a fresh proposal before another model call.
The current hourly reviewer remains available. This implementation does not claim
durable recovery of model output if the entire Actions machine is destroyed.

## Activation still requires owner approval

1. Review and merge the implementation into Gameshed's default branch. GitHub
   delivers `issue_comment` only to workflows installed on that branch. Merely
   creating a branch or PR does not activate execution.
2. In the existing Alfred GitHub App, retain Issues write and grant Contents write
   (isolated review branches), Actions read (run evidence), and Pull requests read.
   Approve the installation's updated permissions and sign in to Alfred again.
   No Actions write permission or new shared callback secret is needed.
3. Let the existing `Alfred-preview` protected environment allow the reviewed main
   branch for the execution job. Keep its existing Anthropic secret; do not copy
   that key to chat or to an issue. GitHub environments can require a separate
   approval per job: do not add that protection if owner approval in Alfred should
   be the only per-task approval. Retain the branch restriction.
4. Publish only the isolated Alfred review deployment using the existing manual
   preview workflow, passing the reviewed main SHA as `executor_sha`.
   It initialises the additive D1 table and pins the runner. Never substitute an
   unrelated SHA. After later main-branch changes, repin only after review.
5. Publish a new harmless source-review proposal, show its exact positive USD cap,
   and get the owner's approval inside Alfred. Observe the **actual** GitHub run,
   Claude response, returned evidence, verified result and next decision after
   refresh. This paid live check is separate from the no-cost test below.

Until all five steps pass, describe the implementation as staged and tested with
a simulated provider, not live or complete. Existing historical project choices
are never inferred as approval for a paid run, merge or deployment.

## Evidence and tests

`node --test --test-concurrency=1 alfred/test/worker.test.mjs alfred/test/execution.test.mjs`
runs the actual Worker HTTP routes, real SQLite transactions and real signed OIDC
tokens against fake GitHub and fake Anthropic. It tests the complete loop, duplicate
clicks, competing claims, expiry/identity/scope restrictions, failed verification,
lost runners, token-budget refusal and next-decision publication.

The pull-request workflow `alfred-tests.yml` also requires a real Docker check:
a correct synthetic change passes, a real regression fails, and the provider key
is absent inside the container. It installs pinned Playwright outside the source
tree and tests the mobile approval button through to the refreshed next decision.
There are no Anthropic credentials in this test workflow and no real API calls.

Official protocol references:
- https://platform.claude.com/docs/en/api/messages-count-tokens
- https://platform.claude.com/docs/en/about-claude/pricing
- https://docs.github.com/en/actions/reference/security/oidc
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#issue_comment
