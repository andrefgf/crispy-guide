import { test } from '../../fixtures/metamask'
import { recoverMessageAddress } from 'viem'
import type { BrowserContext, Page } from '@playwright/test'
import * as mm from '../../utils/metamask-actions'
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA, type Chain } from '../../utils/networks'
import { openTestDapp, readDappState, waitForDapp, dumpDappLog, dapp } from '../../utils/test-dapp'

/**
 * MATRIX RUNNER — MetaMask × the in-repo test dApp, across chains.
 *
 * WHY THIS FILE EXISTS
 * Every verdict before this one was measured through app.aave.com, on one chain.
 * That made two questions inseparable: "how does this WALLET behave?" and "what
 * does THIS DAPP's connector stack do?". The Aave investigation
 * (docs/findings/aave-base-sepolia-wagmi-fuji.md) is the proof of how expensive
 * the confusion is — weeks spent on what turned out to be one dApp asking for
 * Avalanche Fuji on its Base Sepolia market.
 *
 * `test-dapp/index.html` removes the framework entirely: raw EIP-6963 discovery,
 * raw EIP-1193 calls, no wagmi, no build step. A failure here is the wallet's.
 * And because the chain is a parameter rather than an integration, covering
 * wallets × chains costs one line per chain instead of one project per chain.
 *
 * WHAT EACH CHAIN IS FOR — they exercise DIFFERENT wallet code paths:
 *   base-sepolia      MetaMask does NOT ship with it → switch fails 4902, the
 *                     wallet must ADD the network first.
 *   ethereum-sepolia  MetaMask DOES ship with it → a plain switch should
 *                     succeed, no add.
 * `chainEntry` in the verdict records which path was actually taken, so "how did
 * this wallet get onto this chain" is measured rather than assumed.
 *
 * Verdict model is the matrix's, unchanged:
 *   pass / fail — measured. Test stays green either way; a `fail` is a finding.
 *   blocked     — could NOT measure (harness/env). Throws, test goes red.
 */

const RDNS = 'io.metamask'
const DAPP = 'TestDapp'

/**
 * The chains this column is measured on. Adding one is a line here.
 *
 * `CHAIN=ethereum-sepolia` narrows it to one, which is how you iterate: each
 * cell costs minutes of real wallet time, so running four to debug one is how an
 * afternoon disappears. (Two `--grep` flags do NOT do this — the second replaces
 * the first, so `-g "Ethereum Sepolia" -g connect` silently runs BOTH chains.)
 */
const CHAINS_UNDER_TEST: Chain[] = (() => {
  const all = [BASE_SEPOLIA, ETHEREUM_SEPOLIA]
  const only = process.env.CHAIN
  if (!only) return all
  const picked = all.filter((c) => c.chainName.toLowerCase().replace(/\s+/g, '-') === only)
  if (!picked.length) {
    throw new Error(
      `CHAIN=${only} matches no registered chain (have: ` +
        all.map((c) => c.chainName.toLowerCase().replace(/\s+/g, '-')).join(', ') + ')',
    )
  }
  return picked
})()

/** Slug used in verdict lines: 'base-sepolia', 'ethereum-sepolia'. */
function slug(chain: Chain): string {
  return chain.chainName.toLowerCase().replace(/\s+/g, '-')
}

async function runCell(flow: string, chain: Chain, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
    console.log(
      `MATRIX: ${DAPP}/MetaMask/${flow} = blocked (${message.slice(0, 160)}, chain=${slug(chain)})`,
    )
    throw error
  }
}

function verdict(flow: string, result: 'pass' | 'fail', detail: string): void {
  console.log(`MATRIX: ${DAPP}/MetaMask/${flow} = ${result} (${detail})`)
}

/**
 * Progress marker. Cheap, and the reason is worth stating: the first run of this
 * spec spent 20 minutes and reported only `Target page … has been closed`, which
 * named the teardown rather than the cause. A silent step makes its own stall
 * unfalsifiable — the same lesson as `not-a-chain-dialog` returning without a
 * trace. Every phase now says what it is about to wait for.
 */
function step(message: string): void {
  console.log(`  [testdapp] ${message}`)
}

/**
 * Get the wallet onto `chain`, and REPORT HOW.
 *
 * Try `wallet_switchEthereumChain` first, because that is what a dApp does and
 * because whether a plain switch works is exactly the per-chain difference worth
 * measuring. EIP-1193 says an unrecognised chain rejects with **4902**, which is
 * the signal to `wallet_addEthereumChain` instead. Both paths end with the same
 * assertion — the provider reports the target chain id — so neither is trusted
 * on the strength of a dialog having been clicked.
 */
async function enterChain(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  chain: Chain,
): Promise<'already' | 'switched' | 'added' | 'failed'> {
  if ((await readDappState(page)).chainId === chain.chainIdHex) {
    step(`already on ${chain.chainIdHex}`)
    return 'already'
  }

  step(`wallet_switchEthereumChain → ${chain.chainIdHex}`)
  await dapp.switchChain(page).click()
  if (await settleOn(page, context, extensionId, chain)) return 'switched'

  // The switch did not land. TWO DIFFERENT REASONS, and they must not be
  // conflated — the first version of this line said "switch rejected (code=?)"
  // for both, which is a claim the harness had not measured.
  //
  //   a code  → the wallet ANSWERED and refused (4902 = doesn't know this chain,
  //             4001 = user rejected). A fact about the wallet.
  //   no code → nothing resolved in the time allowed. A fact about our patience.
  const after = await readDappState(page)
  step(
    after.lastErrorCode != null
      ? `switch refused by wallet (code=${after.lastErrorCode}) → wallet_addEthereumChain`
      : `switch never resolved (no code, chainId=${after.chainId ?? '?'}) → trying wallet_addEthereumChain`,
  )

  await dapp.addChain(page).click()
  if (await settleOn(page, context, extensionId, chain)) return 'added'

  step(`could not reach ${chain.chainIdHex} (error=${(await readDappState(page)).error ?? 'none'})`)
  return 'failed'
}

/**
 * Wait for a chain request to resolve, approving a prompt only if one exists.
 *
 * WHY NOT JUST CALL approveFollowUpRequests
 * Because a request can resolve with NO prompt at all, and the first version of
 * this spec did not account for it. `wallet_switchEthereumChain` for a chain the
 * wallet doesn't know rejects immediately with 4902 — nothing is ever shown. But
 * `approveFollowUpRequests` assumes something is coming: in headless it opens
 * `notification.html` and polls its whole budget (30s, then 20s, then 20s) before
 * concluding otherwise. Two of those per cell, plus the wait loops around them,
 * consumed the 10-minute test budget and the cell died in teardown — 20 minutes
 * spent waiting for a dialog that could never appear.
 *
 * So: read the PAGE first. It records the provider's own answer — the new chain
 * id, or the rejection code — which is the ground truth and arrives instantly.
 * Only when the page shows neither do we spend anything on the wallet, and then
 * just one short approval attempt rather than three full budgets.
 *
 * An earlier version of this used `hasPendingRequest` as a "cheap probe" first.
 * That was worse than slow, it was WRONG: that helper closes the notification
 * page in a `finally`, and closing that page is how a user REJECTS — so the
 * probe cancelled the request it was checking for, and the account never
 * arrived. Answering a prompt that isn't there is harmless; asking whether one
 * is there is not.
 */
async function settleOn(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  chain: Chain,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await waitForDapp(
      page,
      (x) => x.chainId === chain.chainIdHex || x.lastErrorCode != null,
      8_000,
    )
    if (s.chainId === chain.chainIdHex) return true
    if (s.lastErrorCode != null) return false // the wallet answered: rejected

    // Answer a prompt if one is there. ONE attempt, SHORT budget: the cost of
    // guessing wrong is bounded, and nothing is destroyed if no prompt exists.
    //
    // Do NOT use hasPendingRequest here — see its warning. It closes the
    // notification page unconditionally, and closing that page IS a rejection,
    // so probing with it cancels the request it is probing for.
    step('answering any pending prompt')
    await mm.approveFollowUpRequests(context, extensionId, 1, 12_000, chain).catch(() => 0)
  }
  return (await readDappState(page)).chainId === chain.chainIdHex
}

/** Connect, and leave the wallet on `chain`. Shared by both cells. */
async function connectOn(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  chain: Chain,
): Promise<{ account: string | null; chainId: string | null; entry: string }> {
  step(`open test dApp (rdns=${RDNS}, chain=${slug(chain)})`)
  await openTestDapp(page, { rdns: RDNS, chain })

  step('eth_requestAccounts → approving in MetaMask')
  await dapp.connect(page).click()
  await mm.connectToDapp(context, extensionId)

  // WAIT PATIENTLY — DO NOT RE-PROBE.
  //
  // The failure that cost two runs: the first connect after a cold MetaMask boot
  // produced `account=none` with NO error, i.e. eth_requestAccounts neither
  // resolved nor rejected. The instinct is to retry the approval. That instinct
  // is wrong here, because BOTH ways of asking "is a request still pending?" are
  // destructive when the answer is yes-but-not-rendered-yet:
  //
  //   hasPendingRequest        closes the notification page in a `finally`
  //   getNotificationPage      closes the page it opened when its budget expires
  //
  // …and closing MetaMask's notification window is how a user REJECTS. Since the
  // repo already documents that this UI needs ~30s to boot in headless, a short
  // retry budget is a machine for cancelling the request it is trying to help.
  //
  // So: one long wait, no probing. If the account never arrives, dump the page's
  // own timeline instead of guessing at the cause.
  const connected = await waitForDapp(page, (s) => !!s.account, 90_000)

  step(`account=${connected.account ?? 'none'} chainId=${connected.chainId ?? '?'}`)
  if (!connected.account) {
    await dumpDappLog(page, 'connect produced no account')
    throw new Error(`connect: no account after approval (error=${connected.error ?? 'none'})`)
  }

  const entry = await enterChain(page, context, extensionId, chain)
  const after = await readDappState(page)
  return { account: after.account, chainId: after.chainId, entry }
}

/**
 * No retries (a cell verdict is a measurement, not a flaky assertion), and a
 * 4-minute budget rather than the config's 10.
 *
 * This dApp is one static file with no network calls — every wait here is the
 * WALLET responding. The Aave specs need a long budget because Aave itself is
 * slow; borrowing that budget hid a stall for 20 minutes and then reported
 * teardown noise instead of a cause. A cell that hasn't finished in 4 minutes
 * has stopped making progress, and failing fast is what makes it diagnosable.
 */
test.describe.configure({ retries: 0 })

/** Per-cell budget. Applied via test.setTimeout — see the note in each test. */
const CELL_TIMEOUT_MS = 240_000

for (const chain of CHAINS_UNDER_TEST) {
  test.describe(`Matrix — TestDapp × MetaMask × ${chain.chainName}`, () => {
    test('connect', async ({ page, context, extensionId }) => {
      // Set on the test itself. The file-level describe.configure({ timeout })
      // did not bind — cells still ran ~14 minutes — and an unbounded cell is
      // how a stall costs 20 minutes instead of reporting a cause.
      test.setTimeout(CELL_TIMEOUT_MS)
      await runCell('connect', chain, async () => {
        const { account, chainId, entry } = await connectOn(page, context, extensionId, chain)

        // The whole cell: an authorised account, on the chain we asked for. No
        // dApp UI in the assertion — the provider is the ground truth.
        const ok = !!account && chainId === chain.chainIdHex
        verdict(
          'connect',
          ok ? 'pass' : 'fail',
          `account=${account}, chainId=${chainId} (expected ${chain.chainIdHex}), ` +
            `chainEntry=${entry}, chain=${slug(chain)}`,
        )
      })
    })

    test('sign', async ({ page, context, extensionId }) => {
      test.setTimeout(CELL_TIMEOUT_MS)
      await runCell('sign', chain, async () => {
        const { account, chainId, entry } = await connectOn(page, context, extensionId, chain)
        if (!account) throw new Error('sign: no authorised account after connect')

        await dapp.sign(page).click()
        await mm.approveFollowUpRequests(context, extensionId, 2, 60_000, chain).catch(() => 0)

        const signed = await waitForDapp(page, (s) => !!s.signature || !!s.error, 60_000)
        if (!signed.signature) {
          throw new Error(`sign: no signature returned (error=${signed.error ?? 'none'})`)
        }

        // GROUND TRUTH: recover the signer from the signature itself. The page
        // mints a fresh timestamped message per click, so a canned signature from
        // a mocked provider recovers to the wrong address — this cell cannot be
        // faked by a stub, which is the entire point of driving a real wallet.
        const recovered = await recoverMessageAddress({
          message: { raw: signed.messageHex as `0x${string}` },
          signature: signed.signature as `0x${string}`,
        })

        const ok = recovered.toLowerCase() === account.toLowerCase()
        verdict(
          'sign',
          ok ? 'pass' : 'fail',
          `recovered=${recovered}, account=${account}, chainId=${chainId}, ` +
            `chainEntry=${entry}, chain=${slug(chain)}`,
        )
      })
    })
  })
}
