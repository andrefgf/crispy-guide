# Aave Base Sepolia disconnects a wallet that declines its Avalanche Fuji switch

**Status:** Confirmed, cross-wallet (MetaMask 13.39.1, Rabby 0.93.100). Reproduced in CI — Matrix run #20, 2026-08-15.
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

## Cross-wallet confirmation — Matrix run #20

The same result on two independent wallets, driven through one identical chain-approval policy:

```
Aave/MetaMask/connect  →  WALLET AUTHORISED BUT DAPP SHOWS NO ACCOUNT,
                          chainId=0x14a34 (expected 0x14a34), chipVisible=false
Aave/Rabby/connect     →  WALLET AUTHORISED BUT DAPP SHOWS NO ACCOUNT,
                          chainId=0x14a34 (expected 0x14a34), chipVisible=false
```

Two different wallets producing an identical failure under identical, correct behaviour is strong evidence the cause is dApp-side, not wallet-side.

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
