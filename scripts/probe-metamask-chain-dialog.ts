/**
 * Capture what MetaMask 13.39.1 actually renders on an add-network prompt.
 *
 *   pnpm run probe:mm:chain
 *
 * WHY THIS EXISTS
 * `utils/chain-policy.ts:looksLikeChainDialog` decides, by phrasing, whether a
 * wallet notification is a network add/switch prompt. It matches Rabby and — run
 * #19 — silently misses MetaMask, so MetaMask falls through and APPROVES the
 * Avalanche Fuji switch the guard exists to refuse. The cell is retracted until
 * the detector matches both columns.
 *
 * The fix is one clause in one regex. The rule the codebase keeps relearning is:
 * do NOT guess it from the minified bundle (that cost a day on the 13.13.1 ->
 * 13.39.1 testid rename). Read the real wording first, then match it.
 *
 * This probe reproduces the exact dialog WITHOUT Aave or any external dApp: it
 * loads a local page (every request fulfilled in-process, no network), asks the
 * injected MetaMask provider to add Avalanche Fuji, and reads the resulting
 * notification through the SAME `readChainDialog` the guard uses. It then writes
 * the raw text to matrix-out/mm-chain-dialog/reading.json and prints it.
 *
 * WHAT TO DO WITH THE OUTPUT
 *  - `isChainDialog: false`  -> the detector missed it. Copy the exact phrase
 *    from `haystack`, add it to `looksLikeChainDialog()`, and pin it with a case
 *    in unit/chain-policy.test.ts. That is the whole fix.
 *  - `isChainDialog: true` but a wrong verdict -> the detector is fine; the chain
 *    match is the issue (likely hex vs decimal — already hardened in
 *    decideChainDialog, so re-run the matrix).
 *
 * Reuses the connect fixture's context setup verbatim (fixtures/metamask.ts) so
 * it exercises the real cached wallet, unlocked, under the real browser args.
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import walletSetup from '../wallet-setup/basic.setup'
import {
  browserArgs,
  openMetaMaskHome,
  unlockMetaMask,
  walletProfilePath,
} from '../utils/wallet-cache'
import { getNotificationPage } from '../utils/metamask-actions'
import {
  readChainDialog,
  decideChainDialog,
  logChainVerdict,
  looksLikeChainDialog,
} from '../utils/chain-policy'

// The request Aave fires mid-connect on a clean profile: Avalanche Fuji (43113),
// first entry in its testnet list, which wagmi defaults to. Same params Rabby
// declined (matrix-out-ci/.../run.log), so the two columns face one dialog.
const FUJI = {
  chainId: '0xa869', // 43113
  chainName: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'],
  blockExplorerUrls: ['https://testnet.snowtrace.io'],
}

async function main(): Promise<void> {
  const cachePath = walletProfilePath(walletSetup.hash)
  if (!fs.existsSync(cachePath)) {
    throw new Error(`No wallet cache at ${cachePath}.\nBuild it first: pnpm run build:cache`)
  }

  // Throwaway copy, exactly like the fixture — never mutate the cache.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-chain-probe-'))
  fs.cpSync(cachePath, profile, { recursive: true })

  const context = await chromium.launchPersistentContext(profile, {
    headless: false, // driven by --headless=new in browserArgs() when HEADLESS is set
    channel: process.env.PW_CHANNEL || undefined,
    args: browserArgs(),
    viewport: { width: 1280, height: 720 },
  })

  try {
    // MetaMask's service worker carries its extension id.
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })
    const extensionId = new URL(worker.url()).host

    // Unlock the wallet before the dApp asks it anything.
    const mmPage = await context.newPage()
    await openMetaMaskHome(mmPage, extensionId)
    await unlockMetaMask(mmPage, walletSetup.walletPassword)

    // A local https origin so MetaMask injects window.ethereum. Every request is
    // fulfilled in-process — the probe needs no network and no real dApp.
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><title>mm chain probe</title><h1>probe</h1>',
      }),
    )
    await page.goto('https://dapp.mm-chain-probe.local/')
    await page.waitForFunction(
      () => Boolean((window as unknown as { ethereum?: unknown }).ethereum),
      null,
      { timeout: 30_000 },
    )

    // Fire the add-network request and DO NOT await it to completion — it only
    // settles once the notification is answered, and answering it is the dApp's
    // job, not the probe's. We just need it pending so we can read the prompt.
    await page.evaluate((fuji) => {
      const eth = (window as unknown as {
        ethereum: { request: (a: unknown) => Promise<unknown> }
      }).ethereum
      void eth
        .request({ method: 'wallet_addEthereumChain', params: [fuji] })
        .catch(() => undefined)
    }, FUJI)

    // Read the notification through the guard's own eyes.
    const notif = await getNotificationPage(context, extensionId, 90_000)
    const reading = await readChainDialog(notif, 12_000)
    const verdict = decideChainDialog(reading)
    logChainVerdict('metamask', verdict, reading)

    const outDir = path.join('matrix-out', 'mm-chain-dialog')
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, 'reading.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          metamaskVersion: '13.39.1',
          detector: {
            isChainDialog: reading.isChainDialog,
            looksLikeChainDialog: looksLikeChainDialog(reading.haystack),
          },
          verdict,
          reading,
        },
        null,
        2,
      ),
    )
    await notif.screenshot({ path: path.join(outDir, 'notification.png') }).catch(() => {})

    console.log('\n==================  MetaMask add-network dialog  ==================')
    console.log('painted        :', reading.painted)
    console.log(
      'isChainDialog  :',
      reading.isChainDialog,
      reading.isChainDialog ? '' : '  <-- FALSE = the inert-guard bug',
    )
    console.log('sawChainId     :', reading.sawChainId)
    console.log('inputs         :', JSON.stringify(reading.inputs))
    console.log('haystack       :', JSON.stringify(reading.haystack))
    console.log('verdict        :', `${verdict.decision} — ${verdict.reason}`)
    console.log('written        :', path.join(outDir, 'reading.json'))
    console.log('==================================================================\n')
    console.log(
      reading.isChainDialog
        ? 'Detector already matches. The fix is not the regex — inspect the verdict (hex vs decimal is already handled) and re-run the matrix.'
        : 'Detector MISSED it. Add the exact phrase from `haystack` above to looksLikeChainDialog() in utils/chain-policy.ts, then pin it in unit/chain-policy.test.ts.',
    )
  } finally {
    await context.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
