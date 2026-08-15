# Matrix runner — session state

Branch `matrix-runner`.

## First cell recorded ✅ (2026-07-22)

**Aave / MetaMask / reject = pass** — recorded in prumada-business-os/matrix, chain=base-sepolia. First verified data point. Commit both repos.

## The patient-boot fix worked

Headed run after the fix: no more blank popup. `reject` passed cleanly in 1.4m; `connect` got a real rendered request (previously blank). The 2026-07-22 harness fixes in `utils/metamask-actions.ts` are good — keep them.

## Two flows still not green — and both smell like headed resource pressure, not logic

- **connect = blocked (6.3m):** "MetaMask did not act on 'confirm' — request still pending after 6 steps." The Base Sepolia connect is a 3-popup chain (connect → add network → switch). Clicks are landing on not-yet-wired buttons on a slow/loaded machine, burning the 6-step budget. Their own `connection.spec.ts` does this exact flow and is GREEN in CI (headless).
- **reconnect = crashed:** "MetaMask extension crashed" during the network switch. That's memory/stability, not test logic.

## 2026-07-22 (later still) — connect blocks HEADLESS too → it's logic, not the machine

Headless run: `reject` = pass again (consistent), `connect` = same "still pending after 6 steps". Since headless is the CI-green mode, the machine is exonerated — the connect confirm loop genuinely isn't completing the Base Sepolia connect chain on MetaMask 13.39.1.

Instrumented `resolveRequest` in `utils/metamask-actions.ts` (gated on `MATRIX_DEBUG`, syntax-checked, does not change control flow): logs every visible button + enabled state + testids per step, whether the confirm button is `enabled`, and saves screenshots to `test-results/matrix-debug/`. Prime suspect: a disabled confirm button (new checkbox/scroll gate in 13.39.1) — the `enabled=` line will confirm or kill that instantly.

### 2026-07-24 (final on borrow) — reload fix shipped, STILL failed → quarantined

Run 30101446018 ran commit 58a48a3 (which INCLUDES the reload fix) and borrow still hung. Conclusion: MV3 doesn't just lock the wallet — killing the idle service worker DROPS the in-flight tx request with the worker's memory. Unlock + re-route recovers a locked wallet but cannot resurrect a lost request; the dApp waits on a promise that never resolves. Not fixable from the test side without SW keep-alive.

Applied the pre-agreed guardrail:
- `tests/lending-lifecycle.spec.ts`: borrow/repay/withdraw → `test.fixme` (skipped, don't fail CI) with a full explanatory note. `supply` stays active — it runs early (worker alive) and proves the tx-confirm + on-chain-assertion machinery.
- `e2e.yml`: now runs `playwright test --grep-invert "Matrix"` — the matrix has its own workflow and must not gate the stable e2e suite.

e2e now = connection ×3, edge-cases ×3, supply — all green last run → should pass. Matrix runs in matrix.yml. The MV3-SW-death behaviour is a documented, sellable finding.

### 2026-07-24 (later) — borrow layer 3: post-unlock routing

Re-ran with the 90s budget fix: unlock now HAPPENS (screenshot showed MetaMask unlocked on account Home), but the tx still didn't confirm — because after unlock MetaMask lands on Home, not the queued approval, so the confirm button never appears and Aave hangs on "Borrowing USDT". Fix: `unlockIfLocked` now returns bool; `getNotificationPage` (both headless + headed branches) reloads notification.html immediately after a successful unlock, routing MetaMask to the pending request. This completes the MV3-relock recovery (lock → unlock → re-route → confirm).

If borrow STILL hangs after this, do NOT keep iterating — quarantine borrow/repay/withdraw (test.fixme with a comment) so the matrix PR can merge; the lending lifecycle is tangential to the matrix deliverable, and MV3 relock is a documented finding either way.

### 2026-07-24 — borrow failure diagnosed from report screenshots: LOCKED WALLET

The e2e `borrow` fail (which cascades → repay + withdraw skip) is NOT a lending/testnet issue. The failure screenshot shows MetaMask on its **unlock screen** at the moment the borrow tx fired. Root cause: under headless MV3, Chrome kills MetaMask's idle service worker during the long (~40-min) suite; it restarts LOCKED. `supply` (test #7, early) confirms while the wallet is still warm; `borrow` (test #8, ~5+ min in) hits a re-locked wallet. The confirmation path has `unlockIfLocked`, but `submitModalAction` gave it only a 20s budget — too short for headless popup boot (~30s) + unlock + re-render.

Fix (utils/): `approveFollowUpRequests` now takes `firstTimeoutMs`; `submitModalAction` passes 90s for the known transaction (unlock-aware) while later probes stay short. Should clear borrow → repay/withdraw run → e2e green. Real finding worth noting: MV3 SW re-lock breaks long real-wallet suites that don't re-unlock.

### 2026-07-24 — reconnect bug #2: isVisible() no-op (fixed with waitFor)

After the race fix, reconnect came back `blocked` (neither chip nor CTA in 45s), both attempts. Cause: `locator.isVisible({ timeout })` IGNORES the timeout and returns immediately — so the "wait 30s for the chip" was a no-op that checked the instant after reload, before anything rendered. Fixed to `waitFor({ state: 'visible', timeout: 30_000 })`, which actually blocks. Fixed the same latent no-op in `reject` (was passing only because the button is already present).

Two reconnect bugs total (race, then isVisible no-op) — but neither recorded a false cell: bug #1 showed as flakiness, bug #2 as `blocked`. The discipline held.

connect + reject: green on every run, done. Next Matrix run should give reconnect a STABLE restored/dropped.

### 2026-07-23 (two CI runs) — reconnect FLIPPED → my test had a race bug (fixed)

Same commit, two runs, opposite reconnect verdicts:
- e2e run: reconnect = pass (outcome=restored)
- matrix run: reconnect = fail (outcome=dropped)

That flakiness = a bug in MY test, not an Aave finding. Aave (wagmi) shows the Connect CTA transiently during rehydration, then swaps in the chip. The old 45s race broke on whichever appeared first → caught the transient CTA as "dropped" inconsistently. **Did NOT record reconnect** — a recorded fail would have been false.

Fixed: reconnect now waits up to 30s for the chip (the definitive reconnected signal); `dropped` only if the chip never returns while the CTA is present. Re-run the Matrix workflow:
- consistently `restored` → the old dropped was my bug; record reconnect = pass.
- consistently `dropped` → real Aave session-drop; record fail (a finding).
- still flipping → intermittent session drop IS the finding; record fail w/ note.

Recorded so far (stable across runs): connect = pass, reject = pass.

### borrow (e2e only) — separate, not the matrix
lending-lifecycle borrow (USDT) times out at the modal success/fail wait, both attempts. supply (identical confirm machinery) passes, so it's not my shared-code change — it's a lending/testnet-domain issue. It's the only thing reddening e2e now (matrix cells are green-as-tests there). Investigate via its trace later; not a matrix blocker.

### 2026-07-23 (CI, funded wallet) — 9/13 green; only borrow + reconnect red

Full e2e run with the CI wallet now FUNDED (gas 0.0129 ETH, USDC 19375). typecheck green. Passed: all connection (3), all edge-cases (3), supply, matrix connect + reject. So the shared metamask-actions changes are proven across the whole suite.

Two failures, unrelated:
- **borrow** (lending-lifecycle) — modal never reached "all done" in 180s, borrowing USDT. NOT the matrix; supply (identical confirm machinery) passes, so it's a lending/testnet-domain issue (USDT borrow liquidity / health factor), not my code. Investigate later via its trace.
- **reconnect** — still `reconnected=false` on the OLD spec (this run predated the rewrite).

My rewrite (now bulletproof-typed: plain `runCell` wrapper, no HOF-fixture typing) is READY, unpushed. It: (1) single verdict line per cell, (2) pass/fail = green test so a matrix fail no longer reds e2e, (3) reconnect races chip-vs-connect-CTA over 45s + screenshots the post-reload state.

**Open question on reconnect:** wagmi reconnect *should* be fast (it just re-permits an already-authorised account), which leans toward a REAL drop — but Aave is heavy and a cold headless reload could exceed the old 20s. The 45s race + the chip-vs-CTA distinction + the screenshot settle it next run. Don't record reconnect until then.

Matrix workflow ran green in CI. `pnpm run typecheck` passes locally → my edits are type-clean, so **e2e's failure is NOT the matrix changes** — it's the full lending suite needing a funded wallet (preflight/funds). Separate, pre-existing; don't block the matrix branch on it.

CI verdicts:
- connect = pass (on CI wallet 0xb1c3…c171 — a DIFFERENT wallet than the local 0xf39f…2266, so connect + chipMatches are proven on two wallets)
- reject = pass
- reconnect = fail (reconnected=false, after=null) — AMBIGUOUS: could be a real Aave session-drop-on-reload (Safe #8307 class) OR the old 20s timeout being too short for a heavy reload. Also the old test double-printed (fail + blocked) by asserting cell-success.

**Instrumented (this commit), needs a CI run to resolve:**
- Rewrote the spec to a clean verdict model: exactly ONE MATRIX line per cell; pass/fail = measured (test green), blocked = couldn't measure (test red). No more double lines.
- reconnect now races chip-returns (restored) vs connect-CTA-returns (dropped) over 45s, and captures a post-reload screenshot. `dropped` = real fail; `restored` = pass; neither-in-45s = blocked.
- matrix.yml now uploads `test-results/` + `playwright-report/` so the failure screenshots come back in the artifact.

**Next:** re-run `pnpm run typecheck` (fast), push, read reconnect's single verdict + the screenshot. Only then record reconnect. connect + reject already recorded.

---

### 2026-07-23 — TWO CELLS PASS. Laptop is the wall. Moving to CI.

Recorded (real, verified): **Aave/MetaMask/connect = pass**, **Aave/MetaMask/reject = pass**.
- connect works: dApp bound to authorised account 0xf39f…b92266 (chip 0xf3…2266). Needed the label-click fallback (13.39.1 re-tagged Connect) + a `chipMatches` fix (Aave truncates to 2 head hex, not 4).
- reconnect = blocked: hit the 10-min test timeout / browser closed. Connect alone took **8.8 min** here and the machine OOM'd ("Not enough memory to open this page"). This is RAM, not logic.

**Do not keep grinding the laptop.** It can't sustain headed Chromium + MetaMask + Aave. `connect` at 8.8 min + OOM proves it.

### → Run the matrix in CI (added `.github/workflows/matrix.yml`)

CI is where the suite is already green (7 GB RAM, no Defender). The workflow runs `tests/matrix` headless, extracts every `MATRIX:` line to an artifact + the run summary, and never fails the job on a failing cell (a fail is data).

To use it:
1. Ensure repo secrets `SEED_PHRASE` + `WALLET_PASSWORD` exist (Settings → Secrets and variables → Actions). Throwaway wallet only.
2. Push branch `matrix-runner` (the workflow triggers on it), or Actions → Matrix → Run workflow.
3. Read results in the run Summary, or download the `matrix-results` artifact.
4. Transcribe verdicts with `prumada-business-os/matrix/record.mjs` → `node build.mjs` → commit.

This unblocks everything the laptop can't: reconnect, the transaction cell, more dApps, other wallets — all run in CI now.

---

### ROOT CAUSE FOUND (2026-07-22, from test-failed-5.png)

Connect stuck on MetaMask's connect-permission screen: an enabled **"Connect"** button that never advances after 6 clicks. Version drift — actions written for 13.13.1, running 13.39.1, which re-tagged the footer button. `showsRequest` still matches a confirm testid (so it loops, not errors), but the testid click misses the visible Connect button. Reject works because "Cancel" kept its tag.

**Fix applied** in `utils/metamask-actions.ts`: after the testid click, if a request is still showing, click the visible button by label (`Connect|Confirm|Approve|Sign|Next`). Confirm side only; cancel/reject untouched; additive (skipped entirely when the testid click already worked, so the green suite is unaffected). Syntax-checked, not yet run.

### Run again — headed + connect-only + debug, all in one line so the env var sticks

    $env:MATRIX_DEBUG='1'; pnpm exec playwright test --headed tests/matrix/aave.metamask.spec.ts -g connect

Watch the popup: with the fix, clicking Connect should advance to add-network → switch-network → done, ending in `MATRIX: Aave/MetaMask/connect = pass`. If it still stalls, the `[MM ...]` lines + `test-results/matrix-debug/` PNGs now capture every button/testid — hand those to Claude.

(Earlier debug run created no matrix-debug/ folder — MATRIX_DEBUG wasn't set in the test process. The one-line form above fixes that.)

Then hand Claude: the `[MM ...]` console lines, and/or the PNGs in `test-results/matrix-debug/`. Those name the exact blocker, and the fix is then one targeted change (tick the gate / pick the right button / raise the cap), not a guess.

reject stays recorded. connect + reconnect remain unrecorded (no verdict earned).

---

## (superseded) Next action — run the PROVEN way: headless

CI runs headless and is green; headless is also lighter (no rendering) so the extension is far less likely to crash. Use the repo's own `test` script (sets HEADLESS=true):

    pnpm test tests/matrix/aave.metamask.spec.ts

- connect + reconnect green → record both, done.
- connect STILL blocks headless → it's logic, not the machine. Then harden the confirm loop in `resolveRequest` (raise 6-step cap; after each click, detect whether the request actually advanced before counting the step; re-click dead buttons). Ping Claude with the trace.
- Control if unsure: `pnpm test tests/connection.spec.ts` — if that blocks too, it's the machine (close VS Code/other apps; Defender exclusion for repo + %TEMP%\metamask-profile-*).

Do NOT record connect/reconnect until a run earns a verdict. `reject` stands on its own.

---

## 2026-07-26 (Sun) — `sign` cell written, not yet run

Fourth flow added to `aave.metamask.spec.ts`. Written ahead of Tuesday so the
evening is spent running it, not designing it.

**What gets signed, and why that choice.** Aave exposes no plain `personal_sign`
in its UI, so the cell fires `personal_sign` directly at the injected provider
from Aave's origin. The alternative — driving Aave's permit-signature path —
couples the cell to Aave's supply flow, which the lending suite already covers
and which would make the *wallet* cell fail whenever the *dApp* changed. The
cell must measure the wallet.

**Ground truth.** `recoverMessageAddress` (viem) recovers the signer from the
signature and compares it to the connected account. Per `matrix/flows.md`: not
"the modal closed", not "a toast appeared".

**The nonce matters.** The message carries an ISO timestamp, so it is new on
every run. A mocked provider handing back a canned signature recovers to the
wrong address and the cell reads `fail`. The assertion and the signature share
no assumption — which is the one thing a mocked suite structurally cannot claim.

**Provider resolved by EIP-6963 `rdns`, not `window.ethereum`.** Today the test
profile loads only MetaMask, so both agree and this looks like ceremony. It is
not: on a real browser `window.ethereum` has been observed reporting
`isMetaMask: true` AND `isOneKey: true` simultaneously. The moment Rabby joins
the matrix, a cell trusting the legacy slot would silently measure the wrong
wallet. The verdict line reports which path resolved (`via=`), so a fallback to
the legacy slot is visible rather than silent.

**Approval budget** is 90s on the first request — MV3 can kill and restart the
service worker, and it comes back locked.

**Not yet verified:** the sandbox can't typecheck (pnpm symlink store doesn't
materialise) and can't drive a real wallet. Run `pnpm run typecheck` before the
first run.

### Also fixed
`reconnect`'s blocked message claimed "within 45s" while the wait is 30s. Cosmetic,
but the message is the thing that gets pasted into a diagnosis, so it should be true.

---

## 2026-07-26 (Sun) — local run: 4 red, but the cause is the machine

`pnpm test tests/matrix/aave.metamask.spec.ts` — typecheck clean, all four cells red.

| Cell | Duration | Outcome |
|---|---|---|
| connect | 20.0m | test timeout (600s) ×3 |
| sign | 20.0m | test timeout (600s) ×3 |
| reject | 59.6s | **printed `pass`**, then timed out in teardown |
| reconnect | 5.5m | `blocked` — "did not act on confirm after 6 steps" inside `connectToDapp` |

### What the screenshots actually show

- **connect** (`test-failed-4.png`): Aave sitting on **"Requesting Connection — Open the MetaMask browser extension"**. The dApp fired the request and nothing answered.
- **reconnect** (`test-failed-3.png`): **MetaMask is on the LOCK SCREEN.** Password field empty, Unlock greyed out.

That's the MV3 service-worker death signature — the same one that quarantined
borrow/repay/withdraw. What's new is that it's now hitting **connect**, at the
very start of a run, not just a late transaction. The confirm loop then spends
its six steps hunting for a confirm button on a lock screen.

### Not a code regression

`reject` **printed its verdict and passed.** If the confirm loop or the unlock
path were fundamentally broken, reject would have died too. The logic is intact;
the environment starved.

### Aggravator: `trace: 'on'` is back

`playwright.config.ts:49` has `trace: 'on'`, and there's a `trace.zip` in every
result folder. Tracing snapshots the DOM on **every action** — against a real
MetaMask plus Aave, over a 20-minute run, that's exactly the memory pressure
that gets the service worker reaped. Trace was turned **off** once before for
this precise reason and has drifted back on.

### ⚠️ The sign cell is UNTESTED

`sign` calls `connectWallet` first, and connect never completed. Nothing was
learned about the new code — not that it works, not that it doesn't. Do not
record anything for it.

### Decision: verdicts get earned in CI, not on the laptop

`matrix.yml`'s own header already says it — *"CI, where there's enough memory to
actually drive a real wallet — a laptop OOMs on headed Chromium + MetaMask +
Aave."* Local runs are for iterating on logic; **a cell is only recorded from a
CI run.** This has now cost two evenings across two separate sessions. Stop
paying it.

Consequence for the Rabby work: bring the wallet up locally one cell at a time
with `--trace off` and `MM_DEBUG=1`, but earn every verdict in CI.

---

## 2026-07-26 (Sun) — CI: 4/4 GREEN. MetaMask column complete.

Matrix run #8, commit `4894869`, manually triggered. **Success, 12m 30s, 4 passed.**
https://github.com/andrefgf/defi-wallet-e2e/actions/runs/30212701804

```
connect   = pass  chip="0xb1...c171" == account 0xb1c375ec204f581a4ae3ca04fdbd4292dca1c171
sign      = pass  recovered=0xB1c375ec...c171, account=0xb1c375ec...c171, via=eip6963
reconnect = pass  outcome=restored, before == after
reject    = pass
```

All four transcribed into `matrix/data/results.csv` with the run URL as evidence.
**Aave × MetaMask is 4/4 — the first complete column.**

### The sign cell worked on its first real execution

- `via=eip6963` — the provider was resolved by **rdns**, not the legacy
  `window.ethereum` fallback. That path is now proven, which materially de-risks
  Rabby: the mechanism for targeting a specific wallet among several works.
- `recovered` came back EIP-55 checksummed (`0xB1c3…`) against a lowercase
  `account` (`0xb1c3…`). The case-insensitive comparison handled it. A naive
  `===` would have reported a **false `fail`** — worth remembering for every
  future wallet.

### reconnect: flip-flop resolved

`outcome=restored`, same account either side of the reload. The `waitFor` fix
holds. The two contradictory CI runs from 07-23 were the harness racing, exactly
as diagnosed — `isVisible()` ignoring its timeout.

### The laptop-vs-CI experiment is now settled

Same spec, same commit, hours apart: **laptop all-red, CI all-green.** That is as
clean a natural experiment as this project will ever get, and it retires the
question. Iterate locally; **record only from CI.**

### Note for future runs
The CI wallet (`0xb1c375…c171`, from the `SEED_PHRASE` secret) is a *different*
account from the local `.env` wallet (`0xf39f…2266`). Expected, and correct — but
it means cell notes should always name which account was used, since a reader
comparing two runs would otherwise see a mismatch and assume a bug.

---

## 2026-07-26 (Sun) — Rabby prep done ahead of Wednesday

Three unknowns closed without touching the harness.

**1. Rabby announces cleanly over EIP-6963 — go.**
Probe run with five extensions installed together:

| wallet | rdns |
|---|---|
| Rabby | **`io.rabby`** |
| OneKey | `so.onekey.app.wallet` |
| MetaMask | `io.metamask` |
| Phantom | `app.phantom` |
| Brave Wallet | `com.brave.wallet` |

All five announced **synchronously**. `RDNS = 'io.rabby'` is what the Rabby spec targets.

**2. The legacy slot changed owner — a real finding.**
`window.ethereum` on 2026-07-26 reports `isMetaMask: true` **AND** `isRabby: true`,
with no `providers` array. On 2026-07-21, before Rabby was installed, the same
machine reported `isMetaMask: true` and `isOneKey: true`.

Same laptop, same user, five days apart, different answer — because one more
extension was installed. **Two separate vendors have now been observed claiming
`isMetaMask` on the legacy slot**, so it isn't a OneKey quirk. Anything detecting
wallets via `window.ethereum.isMetaMask` is reading install order, not intent.

This retroactively justifies the sign cell resolving by rdns. Had the Rabby cells
trusted `window.ethereum` they'd have *accidentally* passed — Rabby owns it today —
while the MetaMask cells would have silently measured Rabby.

**3. Distribution: prebuilt zip, no build-from-source.**
`Rabby_v0.93.100.zip`, 16.1 MB, released 24 Jul:
`https://github.com/RabbyHub/Rabby/releases/download/v{VERSION}/Rabby_v{VERSION}.zip`

`scripts/fetch-rabby.mjs` written and wired to `pnpm run fetch:rabby`. Pinned to
0.93.100 by default (`RABBY_VERSION` overrides) — a floating version makes a cell
verdict irreproducible, and MetaMask's 13.13.1→13.39.1 testid rename already cost
us a day. It prints the resolved `manifest.version` so `wallet_version` in
results.csv can finally be filled.

**Untested:** the download itself. Sandbox DNS blocks github.com. The zip's
internal layout is therefore unknown, so `findManifestDir()` accepts manifest.json
at the root *or* one level down and prints which it found. First real run is
`pnpm run fetch:rabby` on the laptop — that is a download, not a wallet flow, so
local is fine.

### Still open for Wednesday
Rabby's **UI actions** — unlock, approve, reject — are the actual work. Nothing
here shortcuts that. Deliberately did NOT write `aave.rabby.spec.ts` or generalise
`metamask-actions.ts`: both need Rabby's real selectors, and guessing them is how
you get a day of debugging a fiction.

---

## 2026-07-26 (Sun) — Rabby import WORKS end to end

`scripts/probe-rabby.ts` drove Rabby 0.93.100 from a fresh profile to an unlocked
dashboard. Every route and selector below is verified, not inferred.

```
#/new-user/guide                           "I already have an address"
#/new-user/import-wallet-type              "Seed Phrase"
#/new-user/import/seed-or-key              12 masked inputs -> "Next"
#/new-user/import/seed-phrase/set-password "Password (8 characters min)"
                                           "Confirm Password" -> "Confirm"
#/new-user/success?hd=HD%20Key%20Tree      "Open Wallet"
index.html                                 dashboard: Swap/Send/Bridge/Receive
```

Written up as `utils/rabby-onboarding.ts`.

### popup.html was never broken
It failed on three earlier probes with "target closed" — because there was **no
wallet yet**. Once the vault existed it painted the full dashboard. Same for
`notification.html`: an approval surface with nothing pending closes itself.
Three runs were spent treating a normal empty state as a defect.

### The one thing NOT established: why fill() fails

`fill()` populated all twelve boxes — correct DOM values, `Next` enabled — and
clicking Next did nothing. No navigation, no error text. `pressSequentially`
immediately afterwards worked.

**Two explanations survive and this run cannot separate them:**

1. The component tracks state via key events and never sees a programmatic value.
2. It validates asynchronously and the click arrived before validation settled.

André raised (2) unprompted and it fits the evidence exactly as well as (1) —
typing 12 words at 30ms/char also spends ~3s, so `type()` changed the input
mechanism **and** the elapsed time. Only one variable should have moved.

**The experiment:** `fill()`, wait 3s, then click.
- advances -> timing, explanation (2)
- does not -> input mechanism, explanation (1)

**Do not write "Rabby cannot be driven by fill()" into the matrix until this is
run.** It would be a published claim about a vendor's product resting on a
confounded experiment, which is exactly the Safe #8307 mistake.

`rabby-onboarding.ts` uses keystrokes because that satisfies both explanations.

### Rabby vs MetaMask, for the record
| | MetaMask | Rabby |
|---|---|---|
| test hooks | `confirm-btn`, `unlock-password`, … | **none** |
| approval page | `notification.html` | `notification.html` (same) |
| full UI | `home.html` | `index.html` |
| manifest | MV3 | **MV3** |
| seed entry | grid | 12 masked inputs, keystrokes required |

MV3 on both means the service-worker death that quarantined borrow/repay/withdraw
is a platform property, not a MetaMask quirk. Expect it here too.

---

## 2026-07-26 (Sun) — RESOLVED: it was timing, not the input mechanism

Controlled three-way run, one variable moved at a time:

```
A  fill() + click immediately      → did NOT advance
B  fill() + settle 3s + click      → ADVANCED  ✅
C  real keystrokes                 → not reached
```

A and B were identical except the 3s wait — both re-entered the words with
`fill()` from cleared boxes. Clean isolation.

**`fill()` works. Rabby validates the seed asynchronously (debounced across all
twelve fields) and `Next` stays enabled the entire time regardless of validity.
A click landing before validation completes does nothing: no navigation, no
error, no clue.**

André called this from the UX before any of it was instrumented. The competing
theory — that Rabby ignores programmatic values and needs real keystrokes — was
mine, was mechanically plausible, and is **false**.

### Why running the experiment mattered
"Rabby cannot be driven by `fill()`" was one step from being written into the
matrix as a published finding about a vendor's product. It would have been
wrong, and wrong in a way a Rabby engineer could disprove in five minutes. The
confound was that `type()` changed the input mechanism AND spent ~3s doing it;
two variables moved, so the earlier run could not distinguish them.

Second time this pattern has appeared (see Safe #8307). The rule holds: when two
explanations fit, isolate before publishing.

### Consequence for the code
`utils/rabby-onboarding.ts` uses `fill()` plus a 3s settle — simpler and faster
than typing 12 words at 30ms/char — with one retry at double the settle, since
the value is empirical and a loaded machine may need longer. The settle is
load-bearing and commented as such; there is no signal to poll for, because the
button never reflects validity.

---

## 2026-07-27 (Mon) — Rabby cache built; lock + approval surfaces probed

`pnpm run build:cache:rabby` → **built and verified**, profile reopened LOCKED
(vault present). Burner address `0xe59c45...706010`.

### Three failures getting there, all the same mistake
Each came from extending a verified path instead of porting it exactly:

1. `fill()` without the preceding `click()` — the probe focused each box first.
2. One pass over the seed grid — the probe only advanced on its **second**.
3. Waiting for the dashboard after "Open Wallet" — **the probe never pressed
   that button.** Everything past it was inference wearing the probe's
   credibility.

Rule, now written down: a probe is evidence for exactly what it did. Port the
sequence, get it green, simplify only afterwards.

### Verified by scripts/probe-rabby-approval.ts

**Lock screen** — `index.html#/unlock`
- `input[placeholder="Enter the Password to Unlock"]`
- buttons: "Unlock with biometrics", "Unlock", "Forgot Password?"
- **Enter submits**, which sidesteps choosing between Unlock and biometrics
- unlocks to `index.html#/dashboard`

**Approval** — `notification.html#/approval`
- heading "Connect to Dapp", origin, chain, "Listed by", "Site popularity"
- buttons: **"Connect"** / **"Cancel"**
- Rabby opens this page **itself**; it appeared unrequested as a 4th page

**Rabby defaults the connect approval to Ethereum**, not Base Sepolia — so the
add/switch-network follow-up is required for Aave, exactly as with MetaMask.

### notification.html was never broken
It self-closes with nothing pending. Three earlier probes recorded "target
closed" and I read it as a defect. The consequence is a real API difference:
MetaMask lets you pre-open `notification.html` and wait; **Rabby does not** —
you must wait for Rabby to open it. `getNotificationPage` differs accordingly.

### Still UNVERIFIED in utils/rabby-actions.ts
Transaction and signature approvals. No probe has driven a signature through
Rabby yet. `CONFIRM_LABELS` therefore carries "Sign" and "Confirm" as
candidates from the shipped locale file, flagged in-comment. Prune the list once
a real signature has been observed — do not assume it.

---

## 2026-07-28 (Tue) — CI #9: Rabby/reject PASS, three cells blocked. Cause found.

Run #9 (`e59627d`) **succeeded** — MetaMask still 4/4, no regression from adding
Rabby, and **Rabby's cache built headless in CI in 1m24s**. Rabby/reject = pass,
recorded. Matrix is 5/16.

connect, sign and reconnect all blocked on the SAME line: `connect.accountChip`
never visible.

### Reject passing was the clue
It proves the whole Rabby harness works: extension loads, profile unlocks, Aave
lists Rabby, `notification.html#/approval` opens, the click lands, Aave returns
to its disconnected state. Only the state AFTER approving fails.

### The measurement that settled it
`scripts/probe-rabby-aave.ts` read the provider rather than the DOM:

```
accounts: ["0xe59c45...706010"]   chainId: "0x1"
>>> CONNECTED but on 0x1 — network switch FAILED
```

Connect works. The wallet is authorised **on Ethereum**.

### And then the screenshot
Aave's follow-up raised Rabby's **"Add Custom Network to Rabby"** dialog,
pre-filled with:

```
Chain ID       43113
Network name   Avalanche Fuji
RPC URL        https://api.avax-test.network/ext/bc/C/rpc
Currency       AVAX
```

**Aave asked for Avalanche Fuji, not Base Sepolia (84532).** `utils/helpers.ts`
already documented this — *"Aave lands the wallet on whatever chain it fancies
(we've watched it add Avalanche Fuji)"* — which is exactly why the MetaMask path
never trusts Aave's switch and calls `wallet_addEthereumChain` itself.

**My Rabby connect flow didn't.** It relied on Aave's switch, which the repo
already knew was unreliable. That's the bug, and it was mine.

### Two fixes
1. **`CONFIRM_LABELS` was missing `/^add$/i`.** Rabby's add-network dialog's
   primary button is **"Add"**, not Confirm. Even a correct request would not
   have been approved. `/^switch/i` added alongside it.
2. **`ensureNetwork()` added to the Rabby spec**, mirroring `helpers.ts`: check
   the chain, fire `wallet_addEthereumChain` with Base Sepolia params ourselves,
   approve Rabby's dialog, then poll until the chain actually changes and throw
   with the observed chainId if it doesn't.

### Side observation, genuinely matrix-relevant
MetaMask and Rabby receive the *same* `wallet_addEthereumChain` and present it
very differently. MetaMask shows a standard approval. Rabby shows a form headed
*"Rabby cannot verify the security of custom networks. Please add trusted
networks only."* Same request, materially higher friction and a security warning
on one wallet. Not one of the four flows, but worth writing up when the matrix
is published.

### Also worth noting
Rabby ships **82 chains, all mainnets**. No Base Sepolia. Every testnet is a
"custom network" with that warning attached.

---

## 2026-07-29 (Wed) — the Rabby connect blocker, finally seen

Six failed attempts, each a genuinely different cause. Worth listing, because the
list *is* the finding:

| # | Symptom | Actual cause |
|---|---|---|
| CI 9 | chain `0x1` | Rabby authorises on Ethereum; no switch driven by us |
| CI 10 | chain `0xa869` | `/^add$/i` missing from CONFIRM_LABELS; then we approved **Aave's** Avalanche Fuji dialog instead of ours |
| CI 11 | job killed at 60m | unbounded `await` on a provider promise that only settles when a dialog is answered |
| CI 12 | chain `0xa869` | chain-ID guard read `input.first()` = **Network name**, not Chain ID (Rabby renders Chain ID as read-only text); and treated an unpainted dialog as "not a chain dialog" and approved it blind |
| local | "NOT pre-provisioned" | fired `wallet_addEthereumChain` at an origin Rabby was **not connected to** |
| local | "Already processing connect" | `clickFirstLabel` awaited the full timeout **per label** — 7 labels × 15s = up to 105s, so the connect approval was never clicked in budget |

### And the one a log could never show

Rabby **disables** the Connect button and displays *"Please process the alert
before signing"* with an **Ignore all** link whenever the origin is unrecognised
(`Listed by: None`). `clickFirstLabel` was finding the button, reading
`isEnabled() === false`, and correctly skipping it — forever.

**It took a screenshot to see this.** Six log-driven iterations could not have
found it, because nothing was erroring; a disabled button is a silent state.

Fixed with `dismissSecurityAlert()`, called at the top of every confirm poll.
This is Rabby's counterpart to MetaMask's Blockaid gate, already handled in
`metamask-actions.dismissSecurityAlert()`.

### Genuinely publishable: both wallets gate approval behind an alert
MetaMask's Blockaid flags Aave's *testnet* contracts as malicious and swaps
Confirm for "Review alert". Rabby flags *unlisted origins* and disables Connect
until "Ignore all" is clicked. Same class of gate, different trigger, different
mechanics, and **both are invisible to a mocked provider** — a stub has no
reputation service and no alert to clear. That belongs in the matrix write-up.

### Cost, stated plainly
The Rabby column has taken roughly 6× the MetaMask column. That is not thrash:
Rabby ships **zero** test hooks, treats every testnet as an unverifiable custom
network, and gates approval behind a security acknowledgement. Those three facts
are the honest answer to "how testable is this wallet", and they are worth more
published than a fourth green tick.

### RESOLVED 2026-07-29 — eight iterations

```
[rabby] cleared a security alert gating the primary button
connected: ["0xe59c45fb2835a60487632d3146ac9306bb706010"]
[rabby] approved chain dialog for 84532: true
add-chain dialog approved: true (ok)
```

Base Sepolia is now present in the cached Rabby profile before any spec runs, so
`ensureNetwork` should be a fast no-op and Aave's Avalanche Fuji request has
nothing to race.

**The final fix was reading BOTH `innerText` AND every `<input>` value.** I got
this field wrong twice in opposite directions — first reading
`input.first().inputValue()` (that's the Network name), then scanning `innerText`
(which excludes input values, hence `saw ?`). Rabby renders Chain ID inside an
input. Matching against the union of text and input values is what I should have
written instead of picking a side and defending it.

### The three fixes that actually mattered, in order of subtlety
1. **`clickFirstLabel` awaited the full timeout per label** — 7 labels × 15s, so
   the approval was never clicked inside any sane budget. Now one deadline for
   all candidates.
2. **The origin has to be connected before chain RPCs are honoured.**
   `wallet_addEthereumChain` fired at a cold origin raised no dialog at all.
3. **Rabby disables the primary button behind a security alert** for unrecognised
   origins. Silent — a disabled button doesn't error, so no log revealed it. Only
   a screenshot did.

### Method note worth keeping
Six of the eight iterations were driven by logs and each found a real but
non-decisive bug. The two that broke the deadlock came from **looking at a
screenshot** and from **printing the raw evidence** (`inputs=[...]`) instead of
inferring. When a state is silent rather than erroring, instrumentation has to
show the state, not the error.

---

## 2026-07-30 — narrowing the Rabby `connect` divergence (probe:rabby:event)

Purpose: decide WHICH LAYER drops the connection, before naming any vendor.
Hypotheses: A wallet emits nothing · B emits late/wrong · C dApp mishandles ·
D we and Aave hold different provider objects.

### Run 1 — crashed, but not uninformative
`SAME_OBJECT: false`. Died on a 30s timeout clicking "Connect wallet".

Cause was ours: `helpers.dismissAnalyticsPrompt` gates on `isVisible()`, which
ignores its timeout. Consent overlay unpainted → not dismissed → click landed on
the overlay. **Same defect already recorded as fixed on the reconnect cell.**
Fixing a bug is not fixing every instance of it. Both now use `waitFor`.

Resisted concluding D from `SAME_OBJECT: false`. Different object identity is
ordinary — a wallet may announce a wrapper over the same transport. D requires
the objects to DISAGREE, which run 1 never measured.

### Run 2 — D ruled out
Both providers: identical accounts, identical chain, identical fingerprints
(`ctor: "N"`, 51 keys, same flags). Two wrappers, one state.

Crashed again — profile was already authorised for app.aave.com, so the page
loaded connected with the chip rendered and there was no button to click. That
is the reconnect path, which already passes. Added `ensureDisconnected`:
disconnect via Aave's own menu + clear wagmi storage, deliberately leaving
Rabby's site permission intact.

Noted: chip rendered **on chain 0x1**. CI #14 had the correct chain and no chip.

### Run 3 — A and B ruled out; wagmi has the connection
Cold connect. Events:

    +6101ms [rdns]   accountsChanged ["0xe59c45…706010"]
    +6101ms [legacy] accountsChanged ["0xe59c45…706010"]

Prompt, correct payload, on both providers. **A dead, B dead.**

    wagmi.store = {"connections":{...[["10d89c4209a",{
      "accounts":["0xE59c45Fb…706010"],
      "chainId":1,
      "connector":{"id":"io.rabby","name":"Rabby Wallet","type":"inject…

wagmi holds the account and resolved the connector as `io.rabby`. Chip: **false**.

Only `accountsChanged` fired — no EIP-1193 `connect` event. wagmi got the data
regardless, so this is a note, not the cause.

**NOT YET C.** `chainId: 1` — the wallet is on Ethereum mainnet while the market
is Base Sepolia. CI #14 failed with the wallet correctly on `0x14a34`. "No chip
on the wrong network" may be Aave behaving correctly, and matching it to CI #14
would be a false match. The probe skips the `ensureNetwork` step the spec runs.

### Run 4 (pending) — reproduce CI conditions
Added step 4b: `wallet_addEthereumChain` → `approveChainDialog` → poll until
`0x14a34` → re-measure. Decides between:

- chip appears on Base Sepolia → **NOT REPRODUCED**; CI #14 differs for another
  reason (headless / timing / cold profile). Notify nobody.
- chip still absent, wagmi holds account on chainId 84532 → **C**. Notify Aave
  primary. Check `aave/interface`'s wagmi version first — "wagmi has it" is not
  "Aave mishandled it"; the defect could be in wagmi.

### Harness defect found along the way (matters for publication)
`aave.rabby.spec.ts :: authorisedAccount` read `window.ethereum`, not the `rdns`
provider — contradicting the file header, its own docblock, and METHODOLOGY §1.
The sign and reconnect cells called it too.

Nothing failed. No test went red. The address was probably even correct. The
**label** was false: CI #14's note says `provider account=…` for a value read
from the legacy slot. With `SAME_OBJECT: false` on this dApp, "which provider
did you ask" stops being a detail. Now reads both and records disagreement.

### Runs 5 & 6 — the answer, and the retraction

Controlled A/B on the SAME probe, wallet starting on 0x14a34 both times. Only
the chain-dialog policy differed.

| | Aave's Fuji request | wallet ends | wagmi | chip |
|---|---|---|---|---|
| default (chain-checked) | **declined** | `0x14a34` ✓ | `connections:[]`, `current:null` | **false** |
| `APPROVE_ANY_CHAIN=1`   | **approved** | `0xa869` ✗ Fuji | 1 conn, `io.rabby`, chainId 43113 | **true** |

The chip renders ONLY when the wallet complies and moves to Avalanche Fuji.
Decline, and wagmi destroys the connection — no wrong-network state, no
recovery. Dialog fields captured verbatim:

    [rabby] inputs=["43113","Avalanche Fuji",
                    "https://api.avax-test.network/ext/bc/C/rpc","AVAX",...]

### Why the Rabby `connect` cell is RETRACTED (fail → blocked)

`metamask-actions.approveFollowUpRequests` → `resolveRequest(…,'confirm',…)`.
No chain check. Blind approve.
`rabby-actions.approveChainDialog` → declines anything that isn't 84532.
Added by us after CI #10 landed on 0xa869.

Same dApp, same behaviour, two harness policies, two verdicts — and the
difference got written down as a difference between the WALLETS. It survived a
CI run, a green suite, and a written cell note. Found only because the probe
printed the dApp's own dialog contents.

**The MetaMask `connect` pass is now flagged too.** It may have approved the
Fuji switch before the chip was asserted, i.e. the chip may have rendered while
the wallet was on the wrong network — the cell never records the chain at the
moment it reads the chip. Not retracted (not shown wrong), not trusted (not
shown right). Asymmetry contaminates both columns; only one looked broken.

Rule now standing: **any harness policy that can change a verdict must be
identical across every column.** A per-wallet safety rule is a per-wallet
measurement bias.

### Open confound — do NOT notify Aave yet

`proto_base_sepolia_v3` is a valid market name (Aave's own testnet faucet uses
it), so the URL is not the problem. But this profile is long-lived, and a stale
market/chain in its storage would produce the same request. "Aave requests the
wrong chain" and "our profile remembered the wrong chain" are both live.

The storage dump was filtered to /wagmi|wallet|connect|recent/ — which would
have hidden the key holding the answer. Now dumps everything.

NEXT: clean-profile run. If Fuji is requested on a fresh profile, it is a
dApp-level finding, wallet-independent, and goes to `aave/interface` under the
10-working-day policy.

### Run 7 — CLEAN PROFILE. Confound ruled out, cause identified.

`.wallet-cache/rabby` deleted, `build:cache:rabby` re-run, fresh profile.
Teardown reported `already disconnected` — no prior session existed.

Aave still requested **Avalanche Fuji (43113)** on the Base Sepolia market.
Identical dialog fields. So it is not stale profile state.

The full (unfiltered) storage dump gives the cause:

    cbwsdk.store … "metadata":{"appName":"Aave",
      "appChainIds":[43113,84532,421614,534351,11155111,11155420]}
    wagmi.store  … {"connections":[],"chainId":43113,"current":null}
    testnetsEnabled = true

**43113 is the FIRST entry in Aave's own testnet chain list. 84532 is second.**
On a profile with zero history, wagmi's default chain is already 43113 before
any connection exists. `?marketName=proto_base_sepolia_v3` selects the displayed
market (UI confirmed "Base Market V3") but does NOT set the connector's chain.

Filtering the storage dump to /wagmi|wallet|connect|recent/ would have hidden
`cbwsdk.store` — the key holding the answer. Worth remembering.

### The finding, stated at the strength the evidence supports

CERTAIN (reproduced clean, dialog captured verbatim):
1. With the Base Sepolia market selected, connecting triggers a wallet request
   to switch to Avalanche Fuji.
2. Declining that request leaves wagmi with `connections:[]`, `current:null` —
   the established connection is destroyed. No wrong-network state, no error,
   no recovery short of a reload.

INTERPRETATION (Aave's call, not ours):
3. Whether a single wagmi default chain is intended design. Plausibly yes.
   Point 2 is the part that is hard to defend, and it is where the issue should
   lead. Point 1 is the trigger, not the accusation.

Maps exactly onto the matrix's `reject` thesis: a user rejecting a prompt should
land in a handled state, not a destroyed one. This is that, in a shipped dApp,
found only because a real wallet could actually say no.

### Harness change still owed

Both wallet paths must use the SAME chain-dialog policy. Until then neither
`connect` cell is trustworthy. Expected consequence once symmetric: MetaMask and
Rabby BOTH show no chip on Aave Base Sepolia under the safe policy, and both
cells carry the same dApp-level note. That is the truthful matrix.

---

## 2026-08-06 (Thu) — Phantom prep: the gating unknown found BEFORE any harness work

Same pattern as the Rabby prep on 2026-07-26 — close the unknowns without
touching the harness. It has already paid for itself.

### The finding that reshapes the column

**Phantom's help centre states it does not support adding custom networks.** The
supported list is fixed — Solana, Ethereum, Polygon, Base, Bitcoin, Sui, Monad,
HyperEVM, Robinhood Chain — with no manual-add path, and the docs explicitly name
Arbitrum, Optimism, BSC, Avalanche, Linea and zkSync as unsupported.

Every other column reaches Base Sepolia (84532) by firing
`wallet_addEthereumChain`. If that is accurate for the extension's EVM provider,
**Aave x Phantom cannot be measured on Base Sepolia at all.**

### Why that is NOT four failing cells

The matrix pins `chain = base-sepolia`. **That pin is a harness policy**, and
`utils/chain-policy.ts` already states the rule it falls under:

> ANY harness policy that can change a verdict must be identical across every
> column.

Recording `fail` against Phantom for a chain it never claimed to ship would be
blaming the wallet for our scope decision. That is the same class of error as the
2026-07-30 Rabby retraction (two chain policies, one recorded as a wallet
difference) and the withdrawn Aave finding. The honest outcomes are:

- an **`unsupported`** cell carrying the verbatim error, or
- moving the Phantom column to a chain Phantom actually ships.

Phantom has a **Testnet Mode** (Settings → Developer Settings) exposing Ethereum
Sepolia. Aave has a Sepolia market. Whether Testnet Mode also exposes Base
Sepolia is **UNKNOWN**. If the column has to move to Ethereum Sepolia, the matrix
must say so per-cell — a cell measured on a different chain is not comparable to
one that wasn't, and hiding that would be the whole project's own failure mode.

**Do not write any of this into the matrix from a help article.** Help articles
go stale; the `fill()` retraction is what happens when a plausible mechanism gets
published before it is measured. Phase 3 of the probe measures it on the shipped
extension.

### Second finding: Phantom cannot be version-pinned

MetaMask and Rabby publish versioned builds. Phantom ships through the Chrome Web
Store only (id `bfnaelmomeimhlpmgjnjophhpkkoljpa`) and publishes no download.
Searching surfaces several third-party "Phantom download" repos — every one an
unverified mirror of a *wallet*, which is not a trade this project makes.

`scripts/fetch-phantom.mjs` therefore pulls from **Google's own CRX endpoint**
(authentic, but always current) and **prints the resolved version loudly**. The
repo's rule — *"a verdict against whatever was latest that day is not
reproducible"* — is satisfied the other way round: we cannot pin, so we record.
`wallet_version` is mandatory for every Phantom cell, not optional.

`phantomProfilePath()` keys the cache on the resolved version, so a Web Store
update invalidates the profile instead of silently leaving a stale one in place.

### Already known, not re-litigated
`RDNS.phantom = 'app.phantom'` is in `utils/provider-eval.ts`, and the
five-wallet probe on 2026-07-26 saw Phantom announce **synchronously** over
EIP-6963 alongside MetaMask, Rabby, OneKey and Brave. Provider resolution is
solved before the column starts — unlike Rabby, where it wasn't.

### Shipped this session
- `scripts/fetch-phantom.mjs` — CRX fetch, extract, record version. Parse-checked.
- `scripts/probe-phantom.ts` — four phases, each independently useful:
  0 load + manifest (is it MV3? expect service-worker death if so)
  1 onboarding/UI surface inventory — **dumps** routes, buttons, inputs, testids
  2 EIP-6963 announcement + provider fingerprint from the dApp origin
  3 **THE GATE** — `wallet_addEthereumChain(0x14a34)`, recording which of
    *dialog opens* / *rejects with code+message* / *silently resolves* happens
  4 Testnet Mode + chain enumeration — guarded, needs an onboarded wallet
- `phantomExtensionPath()`, `phantomVersion()`, `phantomProfilePath()` in
  `utils/wallet-cache.ts`; `.env.example` vars; `fetch:phantom` + `probe:phantom`.

Deliberately NOT written: `aave.phantom.spec.ts`, `utils/phantom-actions.ts`,
`utils/phantom-onboarding.ts`. Phantom's routes and selectors are unobserved, and
guessing them is how the Rabby column lost an evening to debugging a fiction.

### Next
Run `pnpm run probe:phantom` on the laptop (it is a download plus a look, not a
wallet flow, so local is fine). Read `matrix-out/phantom-probe/*.json` **before**
writing a selector. Phase 3's answer decides whether this column measures Base
Sepolia, moves chain, or records `unsupported`.

Three of the four phases need no seed. Add a burner `PHANTOM_SEED_PHRASE` only
when phase 4 is actually reached.

## 2026-08-06 (Thu) — Phantom probe run 1. Phantom **26.24.0**, MV3.

### The strongest finding, and it is not the chain one

**Phantom's EIP-6963-announced provider carries `isMetaMask: true`.**

```
announced: [{ rdns: "app.phantom", name: "Phantom",
              flags: ["isPhantom", "isMetaMask"] }]
legacy:    { flags: ["isMetaMask", "isSelectingExtension"], hasProviders: true }
```

This is the **third distinct vendor** observed claiming `isMetaMask` — OneKey
(2026-07-21), Rabby (2026-07-26), now Phantom. Two things make it stronger than
either earlier observation:

1. It is on the **announced provider object itself**, not only the legacy
   `window.ethereum` slot. The earlier two were slot observations.
2. `browserArgsFor()` passes `--disable-extensions-except`, so this profile had
   **exactly one extension loaded**. There is no attribution ambiguity: the flag
   is Phantom's, not a neighbour's.

`window.ethereum` also reports `isSelectingExtension` and a `providers` array
with a single wallet installed. Worth understanding before it is described.

Any dApp gating on `window.ethereum.isMetaMask` is reading install order, not
intent. Three vendors, three probes, one conclusion — that is publishable and it
belongs in the write-up regardless of what happens to the Phantom column.

### The chain question: run 1 measured LESS than it looks

```
before: "0x1"   requested: 0x14a34 (Base Sepolia)
outcome: rejected   code: 4901
message: "The Provider is not connected to the requested chain."
```

EIP-1193: **4901 = chainDisconnected** — the provider knows the chain but is
disconnected from it *while connected to others*. **4902** is the "unrecognised,
add it" code. Getting 4901 back from an *add* request is genuinely odd, and it
reads like a refusal.

**It cannot be read that way, because the wallet was never onboarded.** Zero
accounts. A wallet with no accounts is plausibly disconnected from *everything*,
so 4901 may be Phantom's generic no-wallet answer with nothing to do with Base
Sepolia. Two explanations fit; the run cannot separate them. That is precisely
the `fill()` situation, one step from being written into the matrix.

**Control added to phase 3:** fire the identical request for **Base mainnet
(0x2105)**, which IS on Phantom's published list, in the same state. One variable
moves — the chain id.

- both 4901 → the code is wallet state, run 1 measured nothing, re-run onboarded
- codes differ → the response really does depend on the chain

The probe now prints which of those happened, so the next run cannot be
misremembered.

### Phase 1 — routes, and three non-defects

| route | result | reading |
|---|---|---|
| `onboarding.html` | paints: "Create a New Wallet" / "I Already Have a Wallet" | the entry point |
| `popup.html` | target closed | **not broken** — no wallet exists yet |
| `index.html` | "Your file couldn't be accessed" | route simply does not exist in Phantom |
| `notification.html` | exists, paints nothing | **not broken** — nothing pending |

Rabby cost three probes to learn that an empty approval surface closing itself is
normal. Not paying that twice: none of the three is recorded as a defect.

**Selectors will be text/role, as Rabby.** `totalTestIds: 2` for the whole
onboarding page and **neither primary button has one**. Classes are build-hashed
(`_1bgnhl3 kch3850…`) and will churn on every Web Store update — which, with no
version pinning, is not something we control.

### Next
1. Re-run for the control. Read the verdict line the probe now prints.
2. Only if the control says the signal is real: onboard a burner and re-run.

## 2026-08-06 (Thu, later) — a claim retracted, and the screenshot that caught it

André pushed back on *"window.ethereum.isMetaMask reads install order"* and asked
for a controlled multi-wallet run. He was right, and re-reading the evidence shows
the sentence bundled two propositions with only one of them measured.

| | claim | status |
|---|---|---|
| **P1** | a wallet sets `isMetaMask` on its OWN provider | **MEASURED.** Phantom-only profile (`--disable-extensions-except`), the `app.phantom` ANNOUNCED provider carries `isMetaMask`. One extension, no neighbours, no ambiguity. |
| **P2** | `window.ethereum` is won by load/install order | **NOT MEASURED.** 07-21 (MetaMask+OneKey) and 07-26 (five wallets) both show the slot carrying `isMetaMask` plus another vendor's flag — but **neither run ever varied the order.** With order held constant you cannot learn whether order matters. |

P2 was asserted on P1's evidence. P1 is impersonation; P2 is precedence. They are
different findings and only P1 is currently defensible.

**`scripts/probe-provider-identity.ts`** measures P2 properly: same two wallets,
both orders, fresh profile per run, **N repeats per config**, neutral origin
(`example.com` — a dApp's own wagmi enumerates and re-wraps the slot, which would
contaminate it). Baselines per wallet alone so a combined reading can be
attributed rather than guessed.

The repeats are the point. Three outcomes, and the third is invisible to a single
run:
- both orders stable and DIFFERENT -> order decides, P2 supported
- both orders stable and SAME -> order does not decide, **P2 is false as written**
- either config flips between identical runs -> **a RACE**, which is a stronger
  finding than either and cannot be described as "order"

The script prints the verdict so it cannot be misremembered.
`browserArgsForAll()` added; `pnpm run probe:identity`.

### The screenshot caught something else entirely

`3-after-add-chain.png` shows Aave rendering **"Core Instance V3 — Main Ethereum
market"**, $20.43B total market size, mainnet assets, banner advertising Aave V4
on mainnet. The probe navigated to `?marketName=proto_base_sepolia_v3`.

**Aave ignored marketName and served mainnet**, because testnet mode is a
`localStorage` flag and the probe used a raw context instead of a fixture, so
nothing set it. Reading the JSON alone, this was invisible — the phase-3 result
looked clean. It is the same lesson as the withdrawn Aave finding: the screenshot
had the answer and the log did not.

Phase 2's EIP-6963 reading survives (announcement is origin-level, independent of
which market renders) and phase 3's `before: "0x1"` is consistent either way. But
**any probe not going through a fixture must set `testnetsEnabled` itself.**

### Stale comment corrected — it would have killed the Sepolia plan

`playwright.config.ts:41` claimed *"Aave's only live testnet market is Base
Sepolia."* **False.** Aave V3 ships testnet markets on **Ethereum Sepolia
(`proto_sepolia_v3`)**, Arbitrum Sepolia, Base Sepolia, Scroll Sepolia, Optimism
Sepolia and Avalanche Fuji.

This also explains the Fuji request cleanly. The clean-profile storage dump on
07-30 showed `appChainIds:[43113, 84532, 421614, 534351, 11155111, 11155420]` —
that is exactly Aave's testnet list, and **43113 (Fuji) is first**. wagmi defaults
to the first entry. Ethereum Sepolia is 11155111, fifth — so **moving the matrix
to Sepolia does NOT dodge the Fuji switch request.** The chain-dialog policy stays
load-bearing after the move.

### Ethereum Sepolia — approved, and what it costs
Aave has the market, and Phantom ships Ethereum (with Testnet Mode) while shipping
neither Base Sepolia nor Unichain Sepolia. So Sepolia is the candidate chain where
MetaMask, Rabby and Phantom can all be measured **comparably**. Cost: one CI re-run
of two already-green columns. Still to verify: that Phantom's Testnet Mode really
exposes Ethereum Sepolia in the shipped extension, not just in the help centre.

## 2026-08-06 (Thu, run 2) — the control worked. Phantom answers from a STATIC ALLOWLIST.

Identical state (`before: "0x1"` both), one variable moved — the chain id.

| requested | outcome | code |
|---|---|---|
| `0x14a34` Base Sepolia — not on Phantom's list | **rejected** | **4901** |
| `0x2105` Base mainnet — on Phantom's list | **resolved** | returned `null` |

`null` is EIP-3085's success response. The two differ, so **4901 is not a generic
no-wallet answer** and the confound raised in run 1 is dead.

### The part that is stronger than expected

**No wallet existed.** No accounts, no unlock, no approval dialog — Phantom
answered both requests from a **static allowlist before any user was involved.**
Contrast the other two columns, where every chain request raises a dialog a person
must answer (and where Rabby additionally gates it behind a security alert).

Three wallets, three postures toward an unknown chain:

| wallet | posture |
|---|---|
| MetaMask | adds any chain, standard approval dialog |
| Rabby | adds any chain, security warning, primary button **disabled** until "Ignore all" |
| **Phantom** | **refuses without asking anyone** — static list, no dialog, no user |

That comparison is the matrix's actual thesis — *how testable is this wallet* — and
it is worth more published than a fourth green tick.

### Stated at the strength the evidence supports

CERTAIN (measured, reproduced with a control):
1. Phantom rejects `wallet_addEthereumChain` for Base Sepolia with **4901**.
2. It accepts the same call for Base mainnet.
3. It does both with no wallet onboarded and no dialog.

INTERPRETATION (ours, and it must be labelled as such):
4. **4901 is `chainDisconnected`** — per EIP-1193, "disconnected from a specific
   chain *while connected to others*". The canonical dApp recovery is
   `wallet_switchEthereumChain` → catch **4902** (`unrecognisedChain`) → then
   `wallet_addEthereumChain`. A dApp following that standard pattern **will not
   match 4901** and falls through to a generic error rather than a recovery.
   EIP-3085 does not mandate a rejection code, so this is a conformance
   *observation*, **not a violation**. Write it that way or not at all.

NOT ESTABLISHED:
5. Whether an onboarded wallet behaves differently. The confound that mattered is
   dead, but the onboarded run is still owed before a cell is recorded.
6. Whether the Base-mainnet control genuinely *added* anything or no-opped on a
   chain already present. Does not weaken the comparison — the point is the two
   were treated differently — but do not claim more than that.

### Consequence for the matrix
Aave x Phantom on Base Sepolia is **not measurable**. The cell value is
**`unsupported`** with the verbatim error, never `fail`. Recording `fail` would
blame Phantom for our chain pin — the same class of error as the Rabby retraction
and the withdrawn Aave finding.

### ⚠ And it puts a question mark over the Ethereum Sepolia migration
The migration's Phantom rationale is "Phantom ships Ethereum". But Phantom's
testnets sit behind a **Testnet Mode toggle in Settings** — UI state, not something
an RPC can reach. So Sepolia may be refused exactly like Base Sepolia.

Phase 3 now asks a third question: `wallet_addEthereumChain(0xaa36a7)`.

- resolves -> Sepolia is RPC-reachable, migration unlocks Phantom
- 4901 -> it does not; Phantom would need Testnet Mode toggled during cache-build,
  a different piece of work. The migration might still be right for other reasons,
  **but do not move the chain constant on the Phantom rationale.**

**Re-run `pnpm run probe:phantom` before touching anything.**

## 2026-08-06 (run 3) — Sepolia refused too. **Do not do the migration.**

```
0x14a34  Base Sepolia      before=0x1     rejected 4901
0x2105   Base mainnet      before=0x1     RESOLVED (null)
0xaa36a7 Ethereum Sepolia  before=0x2105  rejected 4901
```

### Two things this run added

**1. The control was not a no-op.** The third request reports `before=0x2105` —
the Base-mainnet add **actually switched the wallet** from `0x1`. So Phantom
accepts *and acts on* an allowlisted chain. Run 2's open question ("did the
control add anything, or no-op on a chain already present?") is answered: it acted.

**2. An order confound, named rather than hidden.** All three requests share one
provider in sequence, so state carried: Base Sepolia was asked from `0x1`,
Ethereum Sepolia from `0x2105`. Not strictly independent trials.

The conclusion probably survives — the same 4901 came back from two *different*
starting chains, which is what you would expect if the code concerns the
REQUESTED chain rather than the current one. But "probably" has a job boundary:

- **enough** to make a planning decision (cost of wrongly cancelling a migration:
  one CI run)
- **not enough** to publish a claim about a vendor's product

Before any of this reaches the matrix: each request in its own fresh context,
order randomised. The probe now prints the confound when it detects it.

### DECISION: the Ethereum Sepolia migration is CANCELLED

Its rationale was a stack of three, and only one mattered:

| reason | status |
|---|---|
| unlock the Phantom column | **DEAD** — Sepolia refused over RPC, same as Base Sepolia |
| put all wallets on one comparable chain | moot; Phantom cannot join either way |
| anything wrong with Base Sepolia today | **nothing.** MetaMask 4/4, Rabby 3/4 on it |

Moving the chain constant now costs a CI re-run of two green columns and buys
**nothing**. Base Sepolia stays.

### What a Phantom column would actually cost, stated before anyone commits

Phantom refuses every testnet over RPC. Reaching one means toggling **Testnet Mode
in Settings during cache-build** — UI automation, not an RPC call. That needs:

- `utils/phantom-onboarding.ts` (phase 1 has the entry point: *"I Already Have a
  Wallet"*, and testIds=2 for the whole page, so text/role selectors as with Rabby)
- settings navigation to Developer Settings, plus a toggle
- and **even then** it may expose only Ethereum Sepolia, not Base Sepolia — which
  would put the Phantom column on a different chain from the other two, i.e. not
  comparable, which was the whole objection in the first place

That is Rabby-scale work (Rabby: 6x MetaMask, 8 CI iterations) for a column that
may not be comparable when finished.

### AND THE FINDING IS ALREADY BANKED — no cell required

Three probe runs, zero cells, and the publishable result is already in hand:

| wallet | posture toward an unknown chain |
|---|---|
| MetaMask | adds it, standard approval dialog |
| Rabby | adds it, security warning, primary button **disabled** until "Ignore all" |
| Phantom | **refuses from a static allowlist — no wallet, no dialog, no user asked** |

Plus: **three separate vendors now observed claiming `isMetaMask`** (OneKey,
Rabby, Phantom), the Phantom one on its own EIP-6963-announced provider in a
single-extension profile.

Neither of those needed a single matrix cell. The column is the expensive way to
learn less.

**Recommendation: stop the Phantom column here, write the comparison up, and go
back to the shared connect path** — which unblocks a real cell (Rabby/connect,
7/16 → 8/16) and closes the last known asymmetry in the method.

---

## 2026-08-07 (Fri) — ONE connect path. `utils/connect-flow.ts`.

Phantom stopped at the finding; back to the thing that unblocks a real cell.

### The audit found SIX asymmetries, not one

The blocked cell's note named the ordering question. Reading both paths side by
side found five more, and any of them can move a verdict:

| # | MetaMask path | Rabby path |
|---|---|---|
| 1 | `connectToDapp` → **`approveFollowUpRequests`** → `ensureNetwork` | `connectToDapp` → `ensureNetwork` — **no middle step** |
| 2 | settle poll **60s** | settle poll **45s** |
| 3 | `evalAddChain(rdns)` — **no legacy fallback, by design** | inlined string doing **`chosen \|\| window.ethereum`** |
| 4 | provider-resolution wait per provider-eval | hand-rolled 800ms |
| 5 | `connect.metaMaskOption` from selectors | inline `getByRole(/rabby/i)` |
| 6 | `helpers.currentChainId` | its own local copy |

**#1 is the leading hypothesis.** That middle call is a chance to consume Aave's
own mid-connect Fuji request BEFORE our add-chain goes out. One column had it and
is green; the other did not and is blocked.

**#3 is independently serious.** Three vendors are now observed claiming
`isMetaMask` on the legacy slot (OneKey 07-21, Rabby 07-26, Phantom 08-06), so a
`|| window.ethereum` fallback can silently target the wrong wallet. Same defect
class already found and fixed once in `authorisedAccount` — fixing a bug is not
fixing every instance of it, a lesson this file already records once.

### What shipped

- **`utils/connect-flow.ts`** — one `connectWallet` / `ensureNetwork` /
  `currentChainId`, with a `WalletDriver` holding the only genuinely per-wallet
  parts (rdns, Aave's option locator, `connectToDapp`, `approveFollowUp`).
  Settle budget unified at **60s**, the more generous of the two, so the change
  cannot fail a previously-green cell for want of time.
- **`CHAIN_REQUEST_HOOK`** — installed via `addInitScript` in `fixtures/rabby.ts`,
  it wraps every announced provider's `request` in place and logs each
  `wallet_addEthereumChain` / `wallet_switchEthereumChain` with a timestamp, chain
  id, rdns and a caller heuristic. Aave's calls and ours land in ONE log on ONE
  clock. **This is the measurement the cell has been waiting on** — the ordering
  has been guessed at twice and measured never.
- **`aave.rabby.spec.ts`** — the three local functions replaced by thin wrappers
  delegating to the shared ones. Every call site untouched; 431 → 360 lines.

### A bug in the new module, caught by reading signatures instead of assuming them

The first `WalletDriver` draft had `approveFollowUp(context, extensionId,
expectedChainIdDec)` and passed `BASE_SEPOLIA.chainId`. But both wallets'
`approveFollowUpRequests` are `(context, extensionId, max = 3, firstTimeoutMs)` —
**the third argument is a request COUNT.** That call would have set the loop
ceiling to 84,532.

The chain guard already lives one level down: both call
`decideChainDialog(reading, expectedChainIdDec = TARGET_CHAIN_ID)`, and
`TARGET_CHAIN_ID === BASE_SEPOLIA.chainId`. Passing it from the driver would have
been a second source of truth for one value. Parameter removed.

### MIGRATION ORDER — deliberate

The shared module reproduces **the MetaMask path's behaviour**, because that
column is 4/4 green and is the only connect implementation known to work end to
end. Rabby moves first (its cell is already blocked, nothing to lose). MetaMask
moves after, as a no-op refactor verified by CI staying 4/4. Changing both at once
would leave no way to attribute a regression.

Adopting the green column's behaviour is a starting point, **not** a claim that
the extra approval step is correct. That is what the trace is for.

### NEXT — in this order
1. `pnpm run typecheck` locally (the sandbox has no tsc).
2. Push `matrix-runner`, run the Matrix workflow. **Read the `[chain-order]`
   block before anything else** — it answers the ordering question directly.
3. Then, and only then, decide the Rabby connect cell. Expected outcomes:
   - chip appears → the asymmetry WAS the harness; record `pass` and the earlier
     `fail` is retrospectively confirmed as ours, not Aave's
   - chip still absent with the wallet authorised on 84532 → now a real
     dApp-level finding, on a symmetric harness, and it can go to `aave/interface`
   - either way the trace says which request landed first, which is the thing the
     note demanded
4. Only after Rabby is settled: move `aave.metamask.spec.ts` onto the shared path
   and confirm CI is still 4/4.

**Do not record a verdict from a local run.** Cells are earned in CI — settled
2026-07-26 by the laptop-all-red / CI-all-green natural experiment.

## 2026-08-07 — typecheck failure was MINE, not a finding. Plus `docs/REPRODUCE.md`.

`pnpm run typecheck` returned 14 errors. André's instruction was right: do not
call it a bug until it is proven one. It is not a bug in anything — it is my code
failing this repo's own strictness.

**All 14 in ONE file** (`scripts/probe-provider-identity.ts`), **one root cause**:
`noUncheckedIndexedAccess: true` makes `record[key]` yield `string | undefined`,
and the draft indexed straight in.

Two things worth stating plainly:

- **`utils/connect-flow.ts`, `fixtures/rabby.ts` and `aave.rabby.spec.ts`
  typechecked clean.** The connect-path work — the part that touches the matrix —
  had no errors. The failures were confined to a standalone probe that no cell
  depends on.
- **Fixed properly, not cast away.** `as string` would have silenced the exact
  flag that catches "I assumed this key was there" — the same shape of assumption
  the identity probe exists to test. Replaced the `Record` with a list of
  `{name, path}` narrowed through `find`, and the results `Record` with a `Map`
  whose `.get()` forces the code to say what it does about a miss.

Verified in the sandbox at the same strictness: **TS2322/TS2532/TS2538 count
14 → 0.** A full `pnpm run typecheck` still has to run on the laptop, because the
sandbox has no `@types/node` (pnpm's store does not materialise here) and the
residual `TS2580 Cannot find name 'process'` errors appear in pre-existing files
that compile fine locally.

### `docs/REPRODUCE.md` — new

A step-by-step manual runbook with an **expected result for every step**, so a
surprising output can be compared against something rather than diagnosed from
memory. Covers environment, wallet builds, caches, both probes, local vs CI matrix
runs, and how to read the new chain-order trace.

Two parts carry most of the value:

- **A ranked evidence hierarchy.** Screenshot > raw verbatim values > control run
  > logs, each justified by a specific occasion in this file where the lower tier
  failed and the higher one settled it.
- **A "what may be concluded from what" table**, and the standing rule that when
  an observed result is not in the runbook, the honest report is *"unexpected
  output, cause unknown"* with the raw evidence — not a diagnosis.

It also records the three Phantom **non-defects** (`popup.html` closing,
`notification.html` blank, `index.html` absent) so the three probe runs already
spent learning that they are normal empty states are never spent again.

---

## 2026-08-08 — CI run #16. The instrument works. The experiment did not complete.

Two runs off commit `3f885f6` / merge `1320ec2`.

**E2E #29 (main): SUCCESS, 7 passed 3 skipped, 12.1m.** The shared connect path
did not regress the stable suite. Worth stating first, because that was the risk.

**Matrix #16 (matrix-runner): job succeeded, 27m32s, 1 failed 7 passed.**

### THE TRACE FIRED — first time the ordering has ever been measured

```
[chain-order] Rabby connect — 3 chain request(s)
  + 15177ms  wallet_switchEthereumChain  chainId=0xa869
  + 15190ms  wallet_addEthereumChain     chainId=0xa869 (Avalanche Fuji)
  + 47269ms  wallet_addEthereumChain     chainId=0x14a34 (Base Sepolia)
```

Identical shape on a second cell (14910 / 14916 / 46982 ms), so it reproduces.

**The switch-then-add pair 13ms apart for Fuji is wagmi's canonical recovery:**
try `wallet_switchEthereumChain`, catch the unrecognised-chain error, then
`wallet_addEthereumChain`. **The harness never asks for 43113** — it only ever
asks for 84532. So those two are the dApp's, and **the dApp asks 32 seconds before
we do.**

Alongside them, two declines from the shared policy:
```
[rabby] chain dialog decline: dialog never painted — declining rather than approving something unreadable
[rabby] chain dialog decline: wrong chain (saw 43113, want 84532)
[rabby] inputs=["43113","Avalanche Fuji","https://api.avax-test.network/ext/bc/C/rpc","AVAX",...]
```

### But NO COMPARISON IS POSSIBLE, for two independent reasons

**1. MetaMask/connect never produced a verdict.** It died in fixture setup after
10.1 minutes: `Test timeout of 600000ms exceeded while setting up "metamaskPage"`,
thrown from `openMetaMaskHome` (`utils/wallet-cache.ts:215`) with *"Target page,
context or browser has been closed"*. The other three MetaMask cells passed —
and they call `connectWallet` internally — so MetaMask can still connect. This
reads environmental (MV3 worker death / extension page closing during boot), not
logical. It also cost the 10 minutes that took the run from ~13m to 27m.

**2. I only fitted the instrument to one arm.** `CHAIN_REQUEST_HOOK` went into
`fixtures/rabby.ts` and **not** `fixtures/metamask.ts`. So even had MetaMask's
connect cell passed, there would have been no MetaMask timeline to compare
against. An instrument fitted to one arm of a controlled comparison measures
nothing about the comparison. **Fixed 08-08** — the hook is now in both, and it is
worth having on the MetaMask column *while it still runs the old path*, because
that path is the one that produces a green cell and therefore defines what
"working" looks like.

### The caller heuristic was wrong on 2 of 3 — removed

Every request came back `caller~harness?`, **including both Fuji ones**. Modern
bundlers emit `<anonymous>` frames, so the regex matched page code as readily as
`page.evaluate`. It was labelled a heuristic, which is why it did no damage — but
a confidently-wrong label is METHODOLOGY §7's `provider account=` defect exactly:
a value right by luck, described wrong.

Replaced with **`stackHead`** — the top three stack frames printed verbatim under
each entry. Attribution is a judgement; the evidence for it should be visible in
the log rather than pre-chewed into a word.

### Standing conclusion

**Aave x Rabby x connect stays `blocked`.** One column measured, the other absent,
and the instrument was on one arm. Nothing here is comparative, so nothing here
records a cell.

### Next run needs
1. MetaMask/connect to actually execute. If it times out again in fixture setup,
   that is its own defect and belongs in `openMetaMaskHome`, not in a cell note.
2. Both `[chain-order]` blocks present, so the two orderings can be laid side by
   side.
3. Then, and only then, a verdict on the Rabby cell.

## 2026-08-08 — CI run #17. All 8 cells. Attribution PROVEN. Still no comparison.

**Matrix #17 (`07a1db3`): 8 passed, 13.0m.** MetaMask/connect executed this time,
so every cell produced a verdict. The 10-minute fixture-setup timeout from #16 did
not recur — consistent with it being environmental rather than logical.

```
Aave/MetaMask/connect   = pass   chip="0xb1...c171"
Aave/MetaMask/sign      = pass   Aave/MetaMask/reconnect = pass   .../reject = pass
Aave/Rabby/connect      = fail   chipVisible=false, chainId=0x14a34 (correct)
Aave/Rabby/sign         = pass   Aave/Rabby/reconnect    = pass   .../reject = pass
```

### Replacing the heuristic with raw stack frames paid off immediately

```
+ 15706ms  wallet_switchEthereumChain  chainId=0xa869
             p.request (<anonymous>:22:26)
             Object.switchChain (https://app.aave.com/_next/static/chunks/pages/_app-*.js)
             async Object.connect (https://app.aave.com/_next/static/chunks/pages/_app-*.js)
+ 15711ms  wallet_addEthereumChain     chainId=0xa869 (Avalanche Fuji)
             Object.switchChain (https://app.aave.com/_next/...)      <- same call path
+ 47851ms  wallet_addEthereumChain     chainId=0x14a34 (Base Sepolia)
             eval (eval at evaluate (:234:30), <anonymous>)           <- page.evaluate = ours
```

**No longer a guess.** The two Fuji requests originate in Aave's own bundle,
inside `Object.connect` calling `Object.switchChain` — the canonical wagmi
recovery (try switch, catch unrecognised-chain, add). Ours arrives via
`page.evaluate`, 32 seconds later. Run #16's heuristic had labelled all three
`harness?`; the frames settle it beyond argument.

That is the second time in this file that **printing raw evidence beat computing a
label** (the first: reading the chain id from the union of innerText and input
values instead of picking a side).

### THIRD RUN, THIRD REASON, STILL NO COMPARISON — and all three were mine

| run | why no comparison |
|---|---|
| #16 | hook fitted to `fixtures/rabby.ts` only; and MetaMask/connect died in setup |
| #17 | hook in BOTH fixtures — but **`readChainLog` is only called from `connect-flow.connectWallet`**, and MetaMask still runs `helpers.connectWallet`. The MetaMask fixture collected a timeline that nothing ever printed. |

Instrumenting the collection and forgetting the readout is the same error as
capturing a screenshot on every run and never opening one. **Evidence that is
gathered but never looked at is not evidence.**

### Fixed — `utils/chain-trace.ts`

`readChainLog` could not simply be called from `helpers.ts`: `connect-flow.ts`
imports `helpers.ts`, so that would have made `helpers -> connect-flow -> helpers`
a cycle, whose failure mode is an undefined binding at runtime inside a wallet
test. So the trace moved to its own module with **no dependencies but a type**;
`connect-flow.ts` re-exports it for existing imports, both fixtures import it
directly, and `helpers.connectWallet` now ends with
`readChainLog(page, 'MetaMask connect')`.

MetaMask stays on its own connect path deliberately — it is the green one, and
instrumenting it without changing it is the whole point of a reference.

### What the next run finally makes answerable

MetaMask `connect` **passes with a chip**; Rabby `connect` **fails without one**;
both under the same shared chain policy. Two readings will separate:

- **MetaMask is also asked for Fuji and also declines, yet still gets a chip** ->
  the divergence is real and lives above the harness. The Rabby cell can carry a
  verdict, and the finding is about the dApp's per-connector behaviour.
- **MetaMask is never asked for Fuji** -> the two columns are not being asked the
  same question, the comparison is not like-for-like, and the cell stays blocked
  until it is.

Nothing is recorded until one of those is on screen.

## 2026-08-09 — CI run #18. **THE ORDERING HYPOTHESIS IS DEAD.** Both timelines, side by side.

`9a5e2e3`, 8 passed, 13.0m. Same eight verdicts as #17. And for the first time
since the cell was blocked on 2026-08-02, **both columns printed a timeline.**

```
MetaMask connect — 3 chain request(s)
  + 20189ms  wallet_switchEthereumChain  0xa869                    Object.switchChain (app.aave.com/_next/…)  async Object.connect
  + 20199ms  wallet_addEthereumChain     0xa869 (Avalanche Fuji)   Object.switchChain (app.aave.com/_next/…)  async Object.connect
  + 62316ms  wallet_addEthereumChain     0x14a34 (Base Sepolia)    eval (eval at evaluate …)

Rabby connect — 3 chain request(s)
  + 15712ms  wallet_switchEthereumChain  0xa869                    Object.switchChain (app.aave.com/_next/…)  async Object.connect
  + 15721ms  wallet_addEthereumChain     0xa869 (Avalanche Fuji)   Object.switchChain (app.aave.com/_next/…)  async Object.connect
  + 47971ms  wallet_addEthereumChain     0x14a34 (Base Sepolia)    eval (eval at evaluate …)
```

**Identical.** Same three requests, same origin per request, same order. Aave asks
both wallets for Fuji mid-connect from `Object.connect -> Object.switchChain`;
ours arrives ~32-42s later via `page.evaluate`. Only the absolute timings differ,
and MetaMask is simply slower throughout.

### What that settles

The blocked cell's stated reason was:

> *the ORDER in which each fires its Base Sepolia add-chain relative to the dApp's
> own mid-connect chain-switch request has never been established. If MetaMask's
> lands before the dApp's request and Rabby's lands after, that is a sequencing
> artifact of our harness wearing a wallet's name.*

**It does not. Both land after, by the same margin, in the same order.** The
sequencing artifact hypothesis is dead — six days after it was raised, and by
measurement rather than by argument.

### What it does NOT settle — the asymmetry moved down a layer

Rabby printed, on the same request:
```
[rabby] chain dialog decline: dialog never painted — declining rather than approving something unreadable
[rabby] chain dialog decline: wrong chain (saw 43113, want 84532)
[rabby] inputs=["43113","Avalanche Fuji",...]
```
**MetaMask printed nothing.** Both call `logChainVerdict` — `metamask-actions.ts:444`
and `rabby-actions.ts:242` — so the wiring is symmetric. But the log is silent for
one column and loud for the other, on a request the trace proves both received.

And the silence was **unreadable**, because `logChainVerdict` returned early and
without a trace for `not-a-chain-dialog`. So "MetaMask logged nothing" meant
either:

1. the policy never ran — no dialog appeared in its polling window; or
2. the policy ran, classified the dialog as not-a-chain-dialog, and this function
   silently swallowed it.

Different facts, different consequences, and no amount of re-reading separates
them. **A branch that returns without a trace makes its own absence
unfalsifiable** — the same defect class as `isVisible()` ignoring its timeout, and
as a screenshot captured but never opened.

**Fixed:** `not-a-chain-dialog` now prints too, with `painted=` and any
`sawChainId`, which is the minimum needed to tell it apart from silence.

### The cell stays `blocked` — but the reason has narrowed twice now

- 08-02: "the two columns run different connect implementations" -> fixed
- 08-08: "the ordering has never been established" -> **established, identical**
- 08-09: "we cannot see what MetaMask does with the same dialog" -> instrumented

Next run answers it. Two readings:

- **MetaMask logs a decline too, and still gets a chip** -> both wallets receive
  the same request, both decline, and only one dApp connection survives. That is a
  real per-connector difference in the dApp, measured symmetrically, and the cell
  can finally carry a verdict.
- **MetaMask logs `not-a-chain-dialog`, or nothing reaches the policy at all** ->
  the two columns are not being asked the same question at the dialog layer, and
  the harness still differs somewhere below `approveFollowUpRequests`.

## 2026-08-09 — CI run #19. **The symmetry fix never took. MetaMask's guard is inert.**

`119b472`, 8 passed. One new log line answered a week-old question.

```
[metamask] chain dialog not-a-chain-dialog (painted=true)      x3
[metamask] chain dialog not-a-chain-dialog (painted=true, sawChainId=2026)
[rabby]    chain dialog decline: dialog never painted — declining rather than approving something unreadable
[rabby]    chain dialog decline: wrong chain (saw 43113, want 84532)
```

**Both columns run the policy. Only one column's detector fires.**

MetaMask classified every connect dialog as `not-a-chain-dialog`, all painted. And
`metamask-actions.ts:441-459` (read, not inferred) does this:

```ts
if (kind === 'confirm') { … if (verdict.decision === 'decline') { cancel; continue } }
// falls through ↓
const enabled = await button.isEnabled()   // → clicks CONFIRM
```

**`not-a-chain-dialog` falls through and confirms.** So MetaMask approved Aave's
Avalanche Fuji request. Rabby's detector matched (`saw 43113`) and declined it.

### This is the 2026-07-30 retraction, unfixed — it only changed shape

| | 07-30 (retracted) | 08-09 (now) |
|---|---|---|
| MetaMask | no chain check at all -> blind-approves Fuji | chain check present, **detector never matches** -> falls through -> approves Fuji |
| Rabby | declines anything not 84532 | unchanged |
| outcome | **identical** | **identical** |

The behaviour was never made symmetric. A guard that cannot recognise the dialog
it exists to guard is not a weaker guard, it is *no guard*, and it reads as one in
every code review because the call is right there on line 442.

That is why the trace mattered: `logChainVerdict` returning silently for
`not-a-chain-dialog` hid an inert guard for eight days behind a line of code that
looked correct.

### Consequence: MetaMask/connect must be RETRACTED too

`matrix/data/results.csv` carries `Aave/MetaMask/connect = pass` with a ⚑ reading
*"not been shown wrong, so not retracted; not been shown right, so not trusted."*

**It has now been shown wrong.** The pass is consistent with the wallet sitting on
**Avalanche Fuji** when the chip was read — the 07-30 A/B established that the chip
renders *only* when the wallet complies and moves to Fuji. The cell never records
the chain at the moment it reads the chip, so `chain=base-sepolia` in that note is
the market label, not a measurement.

- `Aave/MetaMask/connect` -> **blocked** (was `pass ⚑`)
- `Aave/Rabby/connect` -> stays **blocked**

Matrix drops to **6 measured · 2 blocked · 8 pending**. That is the honest count.

### Root cause to fix next, and it is narrow

`chain-policy.isChainDialog` keys on action phrasing. It matches Rabby's
"Add Custom Network to Rabby" form and does **not** match whatever MetaMask
13.39.1 renders. Also `sawChainId=2026` on one reading — the chain-id reader
scraped a **year** off the page, so it is finding no real chain id there either.

**Next step: log the raw dialog text on `not-a-chain-dialog` (truncated), so the
actual MetaMask wording is on record.** Do not guess the regex — that is how the
testid rename cost a day. Read what the dialog says, then match it.

## 2026-08-15 — the detector is testable now, and hardened where it was blind

Run #19 left one instruction: capture MetaMask's real add-network wording, then
match it — do not guess. That is still the gate, and it needs a browser plus the
wallet cache, so it stays a run on a real machine. What changed today is
everything AROUND that gate, so the moment the wording is captured the fix is a
two-line drop-in, and the policy can no longer go inert unnoticed.

### 1. The detector is a named, unit-tested function

`chain-policy.isChainDialog` was an inline regex inside `readChainDialog`, so the
one predicate that decides verdicts could only ever be exercised by a 13-minute
wallet run. It is now `export function looksLikeChainDialog(text)` — behaviour
identical — pinned by `unit/chain-policy.test.ts` (13 assertions, runs in ms via
`pnpm run test:unit`, no browser). The Rabby wording it matches and the
transaction / connect wording it must NOT match are regression-locked. A guard
that goes inert again fails a test in milliseconds instead of hiding for eight
days behind a green suite.

### 2. The chain match now accepts hex, not just decimal

`sawChainId=2026` — a *year* — was the tell that the decimal chain-id reader saw
no decimal id on MetaMask's screen at all. If MetaMask prints the id in hex,
`decideChainDialog` matching only `84532` would DECLINE the very Base Sepolia it
was offered, even after the detector is fixed. The match now accepts either
spelling of the target (`84532` or `0x14a34`), bounded so `845321` and `0x14a340`
still miss. Safe by construction: it only ever adds a match for the CORRECT
chain, so it can turn a wrongful decline of the right chain into an approve — it
can never approve a wrong one. Both forms are unit-tested, including the hex-only
case that would have regressed before.

### 3. The capture is one command now, not a "next step"

`scripts/probe-metamask-chain-dialog.ts` (`pnpm run probe:mm:chain`) reproduces
the exact dialog with NO Aave and NO network: it loads a local page whose every
request is fulfilled in-process, asks the injected MetaMask provider to add
Avalanche Fuji, and reads the notification through the SAME `readChainDialog` the
guard uses. It writes `matrix-out/mm-chain-dialog/reading.json` (+ a screenshot)
and prints `isChainDialog`, `sawChainId`, `inputs`, and the raw `haystack`.
Reproducing the prompt without the dApp is the point — run #19 needed a full Aave
connect just to reach it, which is why it took a CI run to see. This gets the
same bytes in ~20s on a dev machine.

### The remaining step — unchanged in intent, now trivial to close

1. `pnpm run typecheck`, then `pnpm run probe:mm:chain` → read
   `matrix-out/mm-chain-dialog/reading.json`.
2. If `isChainDialog: false` (expected): copy the exact phrase from `haystack`
   into `looksLikeChainDialog()` and add a case to `unit/chain-policy.test.ts`.
   That is the whole fix — the fall-through at `metamask-actions.ts:441-459`
   stops approving Fuji the moment the detector fires.
3. If `isChainDialog: true`: the detector is fine; the hex hardening above has
   likely already handled it — re-run the matrix and read the verdict.
4. Re-run the MetaMask + Rabby connect cells. If both decline Fuji symmetrically,
   `Aave/*/connect` can finally carry a verdict instead of `blocked`.

Not closed in-session because the capture needs a real browser + the wallet
cache, and the sandbox this was written in had a Windows-built `node_modules`
whose symlinks dangle on Linux (tsx, playwright, typescript all unresolved) —
reinstalling there would have clobbered the real install. The pure decision logic
WAS verified in-sandbox: `unit/chain-policy.test.ts` runs green under a
standalone tsx, 13/13.

## 2026-08-15 (later) — run #20. Captured MetaMask's wording. It hides the chain id.

`pnpm run probe:mm:chain` reproduced the Fuji add-network dialog off a local page
(no Aave, no network) and read it through `readChainDialog`. Verbatim `haystack`:

```
Add Avalanche Fuji

A site is suggesting additional network details.

Request from
dapp.mm-chain-probe.local

Network
Avalanche Fuji

RPC
api.avax-test.network/ext/bc/C/rpc

Beware of network scams and security risks.

Cancel  Confirm
```

`isChainDialog=false, sawChainId=null, inputs=[]`. Two facts, and the second is
the one that mattered:

1. **The detector missed** because MetaMask 13.39.1 says *"suggesting additional
   network details"* — none of the Rabby-proven alternations. One clause fixes
   it: `additional network details`.

2. **MetaMask prints NO chain id on this screen at all** — only the network name
   and the RPC host. `sawChainId=null`, `inputs=[]` say it plainly. This is what
   `sawChainId=2026` (a *year*) in run #19 was really telling us: there was no
   chain id on the page to read. It is not hex-vs-decimal — it is absent.

   The consequence is the trap: fixing only the detector would make the guard
   recognise the Base Sepolia dialog and then **decline it**, because `84532` /
   `0x14a34` are nowhere on MetaMask's screen. One silent failure swapped for
   another — the wallet stuck OFF the target instead of ON the wrong one.

### The fix, two parts, both unit-pinned

- `looksLikeChainDialog` gains the `additional network details` clause. Verified
  against the captured text; a transaction confirm and the connect-permission
  screen still read as not-a-chain-dialog.
- `decideChainDialog` now approves the target by **RPC host** as well as chain id
  (`TARGET_FINGERPRINT`, derived from `BASE_SEPOLIA.rpcUrls`). The RPC endpoint is
  the field both wallets always render and is the address a transaction is
  actually sent to — the strongest identity a dialog carries. The network *name*
  is deliberately not a positive signal: it is the one field a hostile dApp could
  set freely, whereas an add/switch to the real RPC IS the real network.

`unit/chain-policy.test.ts` now carries the real captured Fuji haystack (→
decline) and a Base-Sepolia variant built from the same template (→ approve via
RPC host, with no id present). 17/17 green under `pnpm run test:unit`.

### Expected effect on the matrix — for the next real run to confirm

With Fuji correctly declined and Base Sepolia approved by RPC, the MetaMask
column should now do what Rabby's already does: decline Aave's Fuji switch, add
Base Sepolia itself, and land there. If a real `pnpm test` shows both columns
declining Fuji symmetrically and both ending on Base Sepolia, `Aave/*/connect`
comes off `blocked` and can finally carry a verdict. Matrix would move from
**6 measured · 2 blocked · 8 pending** toward closing the two connect cells.

NOTE this is a HYPOTHESIS about the verdict until a wallet run confirms it — the
policy logic is proven in isolation (unit tests), the end-to-end behaviour is
not yet re-measured. `pnpm run typecheck` clean is the gate before that run.
