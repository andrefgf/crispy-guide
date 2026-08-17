# Aave Base Sepolia disconnects Rabby when it declines the Avalanche Fuji switch

**Status:** Confirmed for **Rabby 0.93.100**, consistently, runs #14–#21.
**NOT confirmed cross-wallet** — see the correction below. MetaMask's result is
unstable across runs and passed cleanly in #21.
**Do not send this to Aave, or cite it publicly, until the MetaMask column is
explained.** An earlier revision of this file claimed cross-wallet confirmation
on the strength of run #20 alone; run #21 contradicted it. Recorded here rather
than quietly edited, because a retraction that leaves no trace is how the
matrix's own credibility goes.
**Surface:** `app.aave.com` Base Sepolia market × EIP-1193 wallet connect.
**Impact:** A wallet that stays on the market's own chain (Base Sepolia) cannot complete a connection — Aave shows no connected account.

## Summary

Connecting a wallet to Aave's **Base Sepolia** market triggers a mid-connect request to **switch to Avalanche Fuji** (`43113` / `0xa869`) — a different chain than the market on screen. If the wallet **declines** that switch and stays on **Base Sepolia** (`84532` / `0x14a34`), Aave's wagmi client tears the connection down entirely (`connections: []`, `current: null`) and renders no account.

The account chip appears **only** if the wallet **complies** and moves to Avalanche Fuji — that is, only when the wallet ends up on the *wrong* chain for the market.

## What we observed

Controlled A/B — same wallet, same page, only the response to Aave's Fuji request differing:

| wallet's response to the Fuji request | wallet ends on | wagmi connections | account chip |
|---|---|---|---|
| **decline** (stay on Base Sepolia) | `0x14a34` ✓ | `[]`, `current: null` | none |
| **approve** (switch to Fuji) | `0xa869` ✗ (Fuji) | 1, `chainId 43113` | shows |

The Fuji request carries full add-network parameters: `["43113", "Avalanche Fuji", "https://api.avax-test.network/ext/bc/C/rpc", "AVAX", …]`.

At the moment the chip is absent, the wallet is still authorised: `eth_accounts` returns the account and `eth_chainId` returns `0x14a34`. This is not a disconnected wallet — it is a dApp discarding a valid connection because the wallet refused to change chains.

## CORRECTION — the cross-wallet claim did not survive run #21

Run #20 showed both columns failing identically, and this file called that
cross-wallet confirmation. **Run #21, same branch, one commit later, disagreed:**

```
run #20   Aave/MetaMask/connect  = blocked (no chip within 30s)
          Aave/Rabby/connect     = fail    (authorised, no chip)

run #21   Aave/MetaMask/connect  = PASS    (chip="0xb1…c171", chain=base-sepolia)
          Aave/Rabby/connect     = fail    (authorised, no chip)   ← unchanged
```

So the honest position today:

- **Rabby** — reproducible and stable across eight runs. Declines Fuji, ends on
  Base Sepolia, authorised, and Aave renders no account. The controlled A/B
  (approve Fuji → chip appears) was run **on Rabby only**.
- **MetaMask** — **unstable**. Blocked in #20, passed in #21 with the chip
  visible on Base Sepolia. Whatever the mechanism is, it does not stop MetaMask
  the way it stops Rabby.

The A/B in the table above is therefore evidence about **Rabby**, not about
wallets in general, and the sentence "two wallets, one identical result" was a
claim the harness had not measured. It is withdrawn.

This changes what the finding IS, and arguably makes it more interesting: not
"Aave breaks correct wallets" but **"Aave's Base Sepolia market treats two
correctly-behaving wallets differently"** — which is precisely the per-wallet
divergence the matrix exists to surface. It is also not yet a fileable bug
report, because the mechanism behind the difference is unknown.

### Why MetaMask survives — the run #21 log, and a testable hypothesis

The ordering trace kills the obvious explanations first: **both wallets received
the identical three requests, in the identical order, from the identical call
site** (`Object.switchChain` in Aave's bundle, then our own add via `eval`):

```
switch → 0xa869 (Fuji) · add → 0xa869 (Fuji) · add → 0x14a34 (Base Sepolia)
```

So the dApp asks both columns the same question. The difference is in the
**answer**, and the chain-verdict lines show two different shapes:

```
Rabby   connect:  decline: dialog never painted
                  decline: wrong chain (saw 43113, want 84532)   ← a DIALOG was shown, and refused
MetaMask connect: (no decline at all)
                  approve: target chain offered (84532)          ← only OUR Base Sepolia add
```

Rabby raised a dialog for Fuji and our policy refused it. On MetaMask, in the
passing cell, the Fuji requests **never reached our guard as a dialog** — MetaMask
answered them itself. That is expected behaviour for a chain it doesn't have:
`wallet_switchEthereumChain` to an unknown chain rejects immediately with
**4902**, no user interaction.

**Hypothesis: Aave's connector treats the two rejection codes differently.**

| wallet | how the refusal happened | code the dApp sees | connection |
|---|---|---|---|
| Rabby | dialog shown → policy declines | **4001** user rejected | destroyed |
| MetaMask | chain not installed → auto | **4902** unrecognised chain | survives |

Same user intent — "this wallet will not move to Fuji" — expressed as two
different codes, and only one of them is fatal. If it holds, the finding is not
"Aave breaks wallets that decline" but the sharper **"Aave drops the connection
on 4001 but tolerates 4902"**, which is a connector-level bug worth reporting.

It also explains the instability: MetaMask's *other* cells in the same run DO log
`decline: wrong chain (saw ?…)` — when the Fuji **add** dialog does get surfaced
and refused, MetaMask should fail like Rabby. Whether that dialog appears is a
timing race, which is exactly the coin-flip observed between runs #20 and #21.

**Now instrumented, not yet confirmed.** `CHAIN_REQUEST_HOOK` recorded only the
outgoing call; it now also records what came back — `outcome`, EIP-1193 `code`,
and message — so the next run prints the answer beside the ask:

```
+20063ms wallet_switchEthereumChain chainId=0xa869 → REJECTED code=4902 "…"
```

Confirm the codes, then this is fileable.

## Likely root cause — not yet confirmed

Aave's testnet wagmi configuration appears to list Avalanche Fuji as its default/first chain, so wagmi requests a switch to it on connect regardless of which market is open; wagmi then treats a declined switch as a failed connection and clears its state. Confirming this means reading `aave/interface`'s wagmi chain configuration and version — "wagmi cleared the connection" is not yet "Aave misconfigured wagmi," and the defect could live in either. Nothing has been filed upstream pending that check.

## Why it matters

A user already on the correct network for the market — or whose wallet correctly refuses an unexpected chain switch — cannot connect. The only path to a connected state is to accept a switch to an unrelated chain. Correct, security-conscious wallet behaviour is the thing that breaks.

## Reproduce

- `pnpm run probe:mm:chain` — captures the exact MetaMask add-network dialog for the Fuji request (no dApp, no external network).
- `tests/matrix/aave.metamask.spec.ts` and `aave.rabby.spec.ts` — the connect cells record this verdict end-to-end; run via the **Matrix** workflow.

## Reproduce by hand (no harness)

**Preconditions**
- A browser with MetaMask, unlocked, holding any account.
- MetaMask → Settings → Advanced → **Show test networks** = ON.
- Cleanest: switch MetaMask to **Base Sepolia** first (add it if absent — Chain ID
  `84532`, RPC `https://base-sepolia-rpc.publicnode.com`, symbol `ETH`).

**Steps**
1. Open `https://app.aave.com/?marketName=proto_base_sepolia_v3`. If a mainnet
   market shows instead, open Aave's settings (gear) → enable **Testnet mode** →
   reopen the URL. You should see the **Base Market V3**, TESTNET badge.
2. Click **Connect wallet → MetaMask**, approve the accounts prompt.
3. Watch for a **second** MetaMask prompt — an add/switch-network screen for
   **Avalanche Fuji**. This is the trigger: the Base Sepolia market is asking your
   wallet for a *different* chain.

**Branch A — decline (correct wallet behaviour):**
4. Click **Cancel** on the Fuji prompt.
5. Aave's header still shows **"Connect wallet"** — no account chip.
6. Prove the wallet is fine anyway — open the console (F12) on the Aave tab:
   ```js
   await window.ethereum.request({ method: 'eth_accounts' })  // → ["0x…"] your account
   await window.ethereum.request({ method: 'eth_chainId' })    // → "0x14a34" (Base Sepolia)
   ```
   Authorised, on the correct chain — while Aave shows nothing. That is the finding.

**Branch B — approve (control):**
4. First reset: MetaMask → **Connected sites** → remove `app.aave.com` (or use a
   clean profile). Repeat steps 1–3, then click **Approve/Switch** on the Fuji prompt.
5. Aave now shows your account chip — **but** the console `eth_chainId` returns
   **`0xa869`** (Avalanche Fuji), not Base Sepolia. The chip only appears once
   you're on the wrong chain for the market.

**Confirms the finding** if you see the asymmetry: no account on Base Sepolia
(Branch A), account only after moving to Fuji (Branch B).

## Provenance

The chain-approval policy that makes this measurable — declining a chain that isn't the target, identically across every wallet column — is `utils/chain-policy.ts`. The full investigation trail is in `tests/matrix/STATUS.md` (runs #14–#20).
