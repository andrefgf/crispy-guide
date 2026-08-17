import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { Chain } from './networks'

/**
 * Serve `test-dapp/index.html` to a page, with no server process.
 *
 * WHY ROUTE FULFILMENT AND NOT A WEB SERVER
 * A `webServer` in playwright.config would mean a port, a lifecycle, and a
 * failure mode ("port already in use") that has nothing to do with wallets. The
 * page is one static file with no build step, so the browser can be handed its
 * bytes directly. `probe-metamask-chain-dialog.ts` already proved a wallet
 * injects normally into a route-fulfilled origin — MetaMask raised its
 * add-network dialog there.
 *
 * WHY AN https:// ORIGIN
 * Wallets gate injection and permissions on the origin, and some treat
 * `file://` or opaque origins differently. A stable https host keeps the site
 * permission stable across a run (and across reloads, which the reconnect cell
 * depends on) without anything actually being on the network.
 *
 * The origin never resolves in DNS and no request leaves the machine: every
 * request under it is fulfilled from disk.
 */
export const TEST_DAPP_ORIGIN = 'https://test-dapp.prumada.local'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = path.resolve(HERE, '..', 'test-dapp', 'index.html')

export interface TestDappOptions {
  /** EIP-6963 rdns of the wallet under test. Never `window.ethereum`. */
  rdns: string
  /** Chain the page will offer to switch/add. Optional: connect+sign need none. */
  chain?: Chain
}

/** The page URL, with the wallet and chain encoded as query params. */
export function testDappUrl({ rdns, chain }: TestDappOptions): string {
  const params = new URLSearchParams({ rdns })
  if (chain) {
    params.set('chainId', chain.chainIdHex)
    params.set('chainName', chain.chainName)
    params.set('symbol', chain.nativeCurrency.symbol)
    const rpc = chain.rpcUrls[0]
    if (rpc) params.set('rpc', rpc)
    const explorer = chain.blockExplorerUrls[0]
    if (explorer) params.set('explorer', explorer)
  }
  return `${TEST_DAPP_ORIGIN}/?${params.toString()}`
}

/** What the page mirrors onto `window.__dapp`. Read this, not the pixels. */
export interface DappState {
  account: string | null
  chainId: string | null
  signature: string | null
  message?: string
  messageHex?: string
  error: string | null
  lastErrorCode?: number | null
  providers: string[]
  events: { ms: number; rdns: string; event: string; payload: unknown }[]
}

/**
 * Register the route, open the page, and wait until the wallet has announced.
 *
 * Waiting for the announcement here (rather than in every cell) means a spec that
 * gets past this line KNOWS the wallet under test is present — so a later failure
 * is about behaviour, not about the extension having lost its injection race.
 */
export async function openTestDapp(page: Page, options: TestDappOptions): Promise<void> {
  const html = fs.readFileSync(PAGE_PATH, 'utf8')

  await page.route(`${TEST_DAPP_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  )

  await page.goto(testDappUrl(options), { waitUntil: 'domcontentloaded' })

  // The page requests providers on load; announcements arrive within a tick, but
  // an extension service worker may still be booting (MV3 restarts it lazily), so
  // give it a real budget and re-ask rather than failing on the first miss.
  const deadline = Date.now() + 30_000
  for (;;) {
    const seen = (await readDappState(page)).providers
    if (seen.includes(options.rdns)) return
    if (Date.now() > deadline) {
      throw new Error(
        `test-dapp: ${options.rdns} never announced within 30s (saw: ${seen.join(', ') || 'none'})`,
      )
    }
    await page.evaluate(`window.dispatchEvent(new Event('eip6963:requestProvider'))`).catch(() => {})
    await page.waitForTimeout(500)
  }
}

/** Read the page's mirrored state. */
export async function readDappState(page: Page): Promise<DappState> {
  const empty: DappState = {
    account: null, chainId: null, signature: null, error: null, providers: [], events: [],
  }
  return (await page.evaluate(`window.__dapp || null`).catch(() => null) as DappState | null) ?? empty
}

/**
 * Print the page's OWN timeline to the run output.
 *
 * The page has always logged every request it fires and every provider event it
 * receives — into a `<div>` nobody was reading. So a failing cell could say
 * "no account" without anyone being able to tell whether `eth_requestAccounts`
 * was even sent, or whether an `accountsChanged` arrived and the harness missed
 * it. Those are different bugs in different codebases.
 *
 * Cheap, and only called when a cell is about to report something surprising.
 */
export async function dumpDappLog(page: Page, label: string): Promise<void> {
  if (page.isClosed()) return
  const text = await dapp.log(page).innerText().catch(() => '')
  const state = await readDappState(page)
  console.log(`  [testdapp] ---- page timeline (${label}) ----`)
  for (const line of text.split('\n').filter(Boolean)) console.log(`  [testdapp] | ${line}`)
  console.log(`  [testdapp] | providers=${JSON.stringify(state.providers)}`)
  console.log(`  [testdapp] | events=${JSON.stringify(state.events)}`)
  console.log(`  [testdapp] | account=${state.account} chainId=${state.chainId} error=${state.error}`)
  console.log(`  [testdapp] ----------------------------------`)
}

/** The page's controls, by the testids the page guarantees. */
export const dapp = {
  discover: (page: Page) => page.getByTestId('discover'),
  connect: (page: Page) => page.getByTestId('connect'),
  sign: (page: Page) => page.getByTestId('sign'),
  switchChain: (page: Page) => page.getByTestId('switch-chain'),
  addChain: (page: Page) => page.getByTestId('add-chain'),
  account: (page: Page) => page.getByTestId('account'),
  chainId: (page: Page) => page.getByTestId('chain-id'),
  signature: (page: Page) => page.getByTestId('signature'),
  error: (page: Page) => page.getByTestId('error'),
  log: (page: Page) => page.getByTestId('log'),
}

/**
 * Wait for a mirrored field to satisfy `predicate`, without throwing.
 *
 * Returns the last state either way, so a caller can record what it actually saw.
 * Deliberately NOT an assertion: in this suite a cell that does not reach the
 * expected state is a VERDICT to record, not a test to fail — the same rule the
 * matrix specs already follow.
 */
export async function waitForDapp(
  page: Page,
  predicate: (s: DappState) => boolean,
  timeoutMs = 60_000,
): Promise<DappState> {
  const deadline = Date.now() + timeoutMs
  let state = await readDappState(page)
  while (Date.now() < deadline) {
    if (predicate(state)) return state
    // Stop the moment the page goes away. Without this, a test that times out
    // mid-wait reports `page.waitForTimeout: Target page … has been closed` as
    // its verdict reason — teardown noise standing where the real cause should
    // be. Returning the last state lets the caller record what it actually saw.
    if (page.isClosed()) return state
    await page.waitForTimeout(500).catch(() => {})
    state = await readDappState(page)
  }
  return state
}
