import type { Page } from '@playwright/test'
import { BASE_SEPOLIA } from './networks'

/**
 * ONE chain-approval policy, shared by every wallet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * It did not, and that cost a published verdict.
 *
 * `rabby-actions.approveChainDialog` declined any dialog that wasn't offering
 * the chain under test. `metamask-actions.resolveRequest` approved whatever
 * appeared, with no chain check at all. Both behaviours were defensible on
 * their own; together they were a measurement bias.
 *
 * Aave requests a switch to Avalanche Fuji (43113) during connect on its Base
 * Sepolia market. So the Rabby column rejected that request and lost its
 * connection, the MetaMask column accepted it and kept one — and the resulting
 * difference was recorded as a difference between the WALLETS. It survived a CI
 * run, a green suite, and a written cell note, and was found only when a
 * narrowing probe printed the dApp's own dialog contents.
 *
 * The cell was retracted. The rule that replaced it:
 *
 *   ANY harness policy that can change a verdict must be identical across
 *   every column, or the columns are not comparable.
 *
 * ---------------------------------------------------------------------------
 * THE SEAM
 * ---------------------------------------------------------------------------
 *
 * Clicking is wallet-specific — different labels, different testids, different
 * multi-step flows. DECIDING is not. The bias lived entirely in the decision,
 * so the decision is what lives here. Each wallet reads its own notification
 * page, asks this module what to do, and then clicks in its own dialect.
 *
 * ---------------------------------------------------------------------------
 * THE POLICY
 * ---------------------------------------------------------------------------
 *
 * Approve a chain dialog only when it offers the chain under test.
 * Decline on a mismatch. Decline when unreadable.
 *
 * Declining on unreadable is deliberate and is the expensive lesson twice over:
 * an earlier version treated "couldn't read it" as "not a chain dialog" and
 * approved blind, which is how a run landed on Fuji despite a guard already
 * existing. A wallet dialog you cannot read is not a dialog you may accept.
 *
 * The permissive alternative — approve whatever the dApp asks — was considered
 * and rejected. It would land the wallet on Fuji, and every downstream cell
 * (`sign`, `reconnect`) would then be measuring on the wrong chain while the
 * results file claims `base-sepolia`. A blocked cell is honest. A passing cell
 * measured on the wrong network looks like data and is worse than nothing.
 */

/** The chain every cell is measured against. Single-chain suite, for now. */
export const TARGET_CHAIN_ID = BASE_SEPOLIA.chainId

/**
 * How to recognise the target chain when a wallet DOESN'T print its id.
 *
 * MetaMask 13.39.1's add-network dialog shows the network name and RPC endpoint
 * but NOT the chain id (captured 2026-08-15, `probe:mm:chain`). Rabby prints the
 * id. So id-only matching would recognise Base Sepolia in Rabby and silently
 * fail to in MetaMask — declining the very network it is meant to approve.
 *
 * The RPC host is the field BOTH wallets always render, and it is the endpoint a
 * transaction is actually sent to: the strongest identity a dialog can carry. An
 * add/switch to the real Base Sepolia RPC IS Base Sepolia, whatever the screen
 * is captioned. The network NAME is deliberately excluded — it is the one field
 * a hostile dApp could set to anything, so it must not be a positive signal.
 *
 * Derived from BASE_SEPOLIA so an env RPC override updates it too — the dialog
 * for our own add-chain request echoes the same URL, so the two stay in step.
 */
export const TARGET_FINGERPRINT: { rpcHosts: string[] } = {
  rpcHosts: BASE_SEPOLIA.rpcUrls
    .map((u) => {
      try {
        return new URL(u).host
      } catch {
        return ''
      }
    })
    .filter((h) => h.length > 0),
}

export interface ChainDialogReading {
  /** Did the dialog render anything at all? */
  painted: boolean
  /** Does this screen offer to add or switch a network? */
  isChainDialog: boolean
  /** Rendered text plus every input value, joined. */
  haystack: string
  /** Input values, kept separately for logging. */
  inputs: string[]
  /** First plausible chain id found, for the log line. */
  sawChainId: string | null
}

export type ChainDecision = 'approve' | 'decline' | 'not-a-chain-dialog'

export interface ChainVerdict {
  decision: ChainDecision
  reason: string
}

/**
 * Does this screen's text offer to add or switch a network?
 *
 * Pure and exported ON PURPOSE. This detector is the exact thing that was inert
 * on the MetaMask column for eight days (run #19): it matched Rabby's
 * "Add Custom Network to Rabby" and did NOT match whatever MetaMask 13.39.1
 * renders, so MetaMask classified every network prompt `not-a-chain-dialog` and
 * fell through to approve Aave's Avalanche Fuji switch. A detector that decides
 * verdicts must be testable without a browser, against real captured wording —
 * so it lives here as a function, and `unit/chain-policy.test.ts` pins it.
 *
 * Detect on the ACTION (add/switch intent), not on the phrase "chain id": this
 * runs on every confirm screen, transactions included, and a transaction can
 * legitimately show a chain id. Requiring add/switch-network intent keeps a
 * supply or borrow whose chain happens not to match from being silently
 * declined far from its cause.
 *
 * The wallet clauses are each VERIFIED against a captured dialog, not guessed:
 *   - Rabby:    "Add Custom Network to Rabby"        (matrix-out-ci run log)
 *   - MetaMask: "…suggesting additional network details."  (probe:mm:chain,
 *               13.39.1, 2026-08-15)
 * Do not add a wallet clause from a minified bundle — run `probe:mm:chain`, read
 * the captured `haystack`, add the exact phrase, and pin it with a unit test.
 * Guessing a selector is what cost a day on the 13.13.1 -> 13.39.1 testid rename.
 */
export function looksLikeChainDialog(text: string): boolean {
  return /(add|switch)\s+(a\s+)?(custom\s+)?network|custom network|add ethereum chain|additional network details|allow this site to (add|switch)/i.test(
    text,
  )
}

/**
 * Read a wallet notification page without judging it.
 *
 * Waits for paint first. Wallets render an empty shell and fill it in; reading
 * too early returns '' and every downstream check is then operating on nothing.
 */
export async function readChainDialog(
  page: Page,
  paintTimeoutMs = 12_000,
): Promise<ChainDialogReading> {
  // LOCATOR-BASED READS ONLY — not page.evaluate().
  //
  // MetaMask's LavaMoat sandbox blocks page-context JavaScript evaluation on
  // notification pages. page.evaluate() catches the error and returns '', which
  // makes every call look like an empty (unpainted) page — so readChainDialog
  // always returned `painted: false`, decideChainDialog always returned
  // 'decline', and resolveRequest clicked CANCEL on legitimate connection
  // requests. The reject cell passed (it never enters the chain guard); every
  // confirm cell blocked with "MetaMask never showed a pending request".
  //
  // Playwright's locator methods (innerText, inputValue, count) run through the
  // CDP protocol and are not intercepted by LavaMoat.
  let text = ''
  const deadline = Date.now() + paintTimeoutMs
  while (Date.now() < deadline) {
    text = (await page.locator('body').innerText().catch(() => '')).trim()
    if (text.length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!text) {
    return { painted: false, isChainDialog: false, haystack: '', inputs: [], sawChainId: null }
  }

  // Read the rendered text AND every input value.
  //
  // Got this wrong twice, in opposite directions. Reading the first input gave
  // the Network *name*. Reading `innerText` alone excludes input values, and the
  // Chain ID lives in an `<input>` — so that run logged `saw ?`, having found no
  // digits anywhere. Neither source alone can see the field. Match the union.
  //
  // locator.inputValue() also runs via CDP protocol, not page.evaluate, so it
  // is safe from LavaMoat interception.
  const inputLocator = page.locator('input')
  const inputCount = await inputLocator.count().catch(() => 0)
  const inputs: string[] = []
  for (let i = 0; i < inputCount; i++) {
    const val = await inputLocator.nth(i).inputValue().catch(() => '')
    if (val) inputs.push(val)
  }

  const haystack = [text, ...inputs].join(' | ')

  return {
    painted: true,
    // Detect on the ACTION (add/switch intent), not the phrase "chain id".
    // Extracted to looksLikeChainDialog() so it is unit-testable against
    // captured wording — see that function for the full reasoning and the
    // still-unverified MetaMask branch.
    isChainDialog: looksLikeChainDialog(text),
    haystack,
    inputs,
    sawChainId: haystack.match(/\b\d{3,7}\b/)?.[0] ?? null,
  }
}

/**
 * The decision. Pure — no page, no clicking, no wallet.
 *
 * This function is the thing that must be identical across columns. Everything
 * else about how a wallet is driven may differ; this may not.
 */
export function decideChainDialog(
  reading: ChainDialogReading,
  expectedChainIdDec: number = TARGET_CHAIN_ID,
  fingerprint: { rpcHosts?: string[] } = TARGET_FINGERPRINT,
): ChainVerdict {
  if (!reading.painted) {
    return {
      decision: 'decline',
      reason: 'dialog never painted — declining rather than approving something unreadable',
    }
  }

  if (!reading.isChainDialog) {
    return { decision: 'not-a-chain-dialog', reason: 'no network add/switch on this screen' }
  }

  const wantedDec = String(expectedChainIdDec)
  const wantedHex = '0x' + expectedChainIdDec.toString(16)

  // Match the target chain id in EITHER textual form — 84532 and 0x14a34 are the
  // same chain; which one a wallet prints is a rendering choice. Rabby prints
  // decimal (proven: inputs=["43113",...]). Bounded so `4351` can't satisfy `43`,
  // `84532` isn't found inside `845321`, `0x14a34` isn't found inside `0x14a340`.
  const decMatch = new RegExp(`(^|[^0-9])${wantedDec}([^0-9]|$)`).test(reading.haystack)
  const hexMatch = new RegExp(`(^|[^0-9a-fx])${wantedHex}([^0-9a-f]|$)`, 'i').test(reading.haystack)

  // …but MetaMask 13.39.1 prints NO chain id at all: its add-network dialog shows
  // only the name and RPC (captured 2026-08-15 — sawChainId=null, inputs=[]).
  // That is what `sawChainId=2026`, a *year*, was really telling us in run #19 —
  // there was no chain id on the screen to read. Id-only matching would DECLINE
  // Base Sepolia the instant MetaMask is the wallet offering it. So also accept
  // the target's RPC host (see TARGET_FINGERPRINT: the endpoint is the identity
  // to trust; the name is not). Substring, lower-cased, because the dialog shows
  // the host with a path and no scheme ("base-sepolia-rpc.publicnode.com/…").
  const haystackLc = reading.haystack.toLowerCase()
  const rpcMatch = (fingerprint.rpcHosts ?? []).some(
    (h) => h.length > 0 && haystackLc.includes(h.toLowerCase()),
  )

  const matches = decMatch || hexMatch || rpcMatch

  return matches
    ? { decision: 'approve', reason: `target chain offered (${wantedDec}/${wantedHex} or its RPC)` }
    : {
        decision: 'decline',
        reason: `wrong chain (saw ${reading.sawChainId ?? '?'}, want ${wantedDec}/${wantedHex} or its RPC)`,
      }
}

/**
 * One log line, same shape for every wallet, so runs stay comparable by eye.
 *
 * `not-a-chain-dialog` USED TO RETURN SILENTLY, and that silence cost run #18.
 *
 * The chain-order trace proved Aave asks BOTH columns for Avalanche Fuji, in the
 * same order, from the same call path. Rabby then logged two declines. MetaMask
 * logged nothing at all — and "nothing" was indistinguishable between:
 *
 *   - the policy never ran (no dialog appeared in the polling window), and
 *   - the policy ran, classified the dialog as not-a-chain-dialog, and was
 *     silently skipped by this very function.
 *
 * Those are different facts with different consequences for the verdict, and no
 * amount of re-reading the log could separate them. A branch that returns
 * without a trace makes its own absence unfalsifiable.
 *
 * Now every decision prints. `not-a-chain-dialog` is the common case and would
 * be noisy on every transaction confirm, so it prints only what is needed to
 * tell it apart from silence: the decision, and whether anything was painted.
 */
export function logChainVerdict(wallet: string, verdict: ChainVerdict, reading: ChainDialogReading): void {
  if (verdict.decision === 'not-a-chain-dialog') {
    console.log(
      `  [${wallet}] chain dialog not-a-chain-dialog (painted=${reading.painted}` +
        `${reading.sawChainId ? `, sawChainId=${reading.sawChainId}` : ''})`,
    )
    // PRINT WHAT IT ACTUALLY SAID.
    //
    // Run #19: MetaMask classified every connect dialog `not-a-chain-dialog`
    // while Rabby read the same request as a chain dialog and declined it. Since
    // `not-a-chain-dialog` falls through to a confirm click
    // (metamask-actions.ts:441-459), MetaMask approved the very network switch
    // the guard exists to refuse — inert on one column, active on the other.
    //
    // The detector is a regex over phrasing. It matches Rabby's "Add Custom
    // Network to Rabby" and evidently not whatever MetaMask 13.39.1 renders. The
    // fix is one regex, and the ONLY safe way to write it is to read the real
    // wording first: guessing a selector from a minified bundle is what cost a
    // day on the 13.13.1 -> 13.39.1 testid rename.
    //
    // Truncated to 300 chars — enough to identify the screen, short enough that
    // a transaction confirm does not flood a 13-minute run.
    if (reading.painted && reading.haystack) {
      console.log(`  [${wallet}] saw: ${JSON.stringify(reading.haystack.slice(0, 300))}`)
    }
    return
  }
  console.log(`  [${wallet}] chain dialog ${verdict.decision}: ${verdict.reason}`)
  if (verdict.decision === 'decline' && reading.inputs.length) {
    console.log(`  [${wallet}] inputs=${JSON.stringify(reading.inputs)}`)
  }
}
