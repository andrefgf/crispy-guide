import type { Page } from '@playwright/test'

/**
 * Chain-request ordering trace. Standalone by necessity.
 *
 * WHY ITS OWN MODULE
 * This started inside `utils/connect-flow.ts`, which imports from `helpers.ts`.
 * The MetaMask column still runs `helpers.connectWallet`, so reading the trace
 * there would have meant `helpers -> connect-flow -> helpers` — a circular
 * import. ESM tolerates cycles unevenly and the failure mode is an undefined
 * binding at runtime, which is a miserable thing to debug inside a wallet test.
 *
 * So the trace lives here with **no dependencies but a type**, and everything
 * imports it: both fixtures, `connect-flow.ts`, and `helpers.ts`.
 *
 * WHAT IT IS FOR
 * `Aave x Rabby x connect` is `blocked` because the two columns might be firing
 * their Base Sepolia add-chain at different points relative to the dApp's own
 * mid-connect switch request — which would be a sequencing artifact of the
 * harness wearing a wallet's name. Answering that needs both columns' timelines
 * on one clock. Runs #16 and #17 each produced only Rabby's, for two different
 * reasons, and neither run could compare anything.
 */

/**
 * Wrap every announced provider's `request` so chain calls are logged.
 *
 * MUST be installed with `addInitScript` so it runs BEFORE the dApp's scripts
 * and registers its listener first — listeners fire in registration order, so
 * document-start puts us ahead of wagmi. Wrapping mutates `e.detail.provider`
 * in place, and that is the same object reference wagmi receives, so the dApp's
 * calls and ours land in one log on one clock.
 *
 * A string, not a function: tsx/esbuild rewrites named arrows to add a `__name`
 * helper that does not exist in the page. Three probes have hit this.
 */
export const CHAIN_REQUEST_HOOK = `(() => {
  window.__chainLog = []
  var t0 = Date.now()
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e.detail || {}
    var p = d.provider
    if (!p || p.__chainLogWrapped || typeof p.request !== 'function') return
    p.__chainLogWrapped = true
    var rdns = (d.info && d.info.rdns) || 'unknown'
    var orig = p.request.bind(p)
    p.request = function (args) {
      var rec = null
      try {
        var m = args && args.method
        if (m === 'wallet_addEthereumChain' || m === 'wallet_switchEthereumChain') {
          var stack = ''
          try { stack = (new Error()).stack || '' } catch (err) { stack = '' }
          rec = {
            ms: Date.now() - t0,
            method: m,
            rdns: rdns,
            chainId: (args.params && args.params[0] && args.params[0].chainId) || null,
            chainName: (args.params && args.params[0] && args.params[0].chainName) || null,
            outcome: 'pending',
            code: null,
            message: null,
            msEnd: null,
            stackHead: stack.split('\\n').slice(1, 4).map(function (s) {
              return s.trim().replace(/^at\\s+/, '').slice(0, 90)
            })
          }
          window.__chainLog.push(rec)
        }
      } catch (err) { /* never let logging break a request */ }

      // RECORD THE WALLET'S ANSWER, NOT JUST THE DAPP'S QUESTION.
      //
      // Run #21: both columns received the same three requests in the same order
      // (switch Fuji, add Fuji, add Base Sepolia) — the trace proves it — yet
      // Rabby lost its connection and MetaMask kept it. The ask was identical, so
      // the difference has to be in the ANSWER, and the answer was the one thing
      // this hook never captured. EIP-1193 codes are not interchangeable:
      // 4001 (user rejected) and 4902 (unrecognised chain) mean different things
      // to a connector, and a dApp may treat one as fatal and the other as
      // recoverable. A trace that logs only outgoing calls cannot see that.
      //
      // Passive observer: it attaches handlers that swallow, and returns the
      // ORIGINAL promise, so the dApp's own error handling is untouched and no
      // unhandled rejection is created.
      var out = orig(args)
      try {
        if (rec && out && typeof out.then === 'function') {
          out.then(
            function (v) { rec.outcome = 'resolved'; rec.msEnd = Date.now() - t0; return v },
            function (e) {
              rec.outcome = 'rejected'
              rec.code = (e && typeof e.code !== 'undefined') ? e.code : null
              rec.message = String((e && e.message) || e || '').slice(0, 160)
              rec.msEnd = Date.now() - t0
            }
          )
        }
      } catch (err) { /* observation must never change behaviour */ }
      return out
    }
  })
})()`

export type ChainLogEntry = {
  ms: number
  method: string
  rdns: string
  chainId: string | null
  chainName: string | null
  /** What the WALLET answered. 'pending' means it never settled. */
  outcome: 'pending' | 'resolved' | 'rejected'
  /** EIP-1193 code on rejection. 4001 = user rejected, 4902 = unrecognised chain. */
  code: number | null
  message: string | null
  msEnd: number | null
  stackHead: string[]
}

/**
 * Read the timeline back and print it. Safe on a page without the hook.
 *
 * Prints the top stack frames verbatim under each entry rather than a computed
 * label. Run #16 carried a `likelyCaller` heuristic that returned 'harness?' for
 * all three requests — including both Avalanche Fuji ones, which the harness
 * never sends. Bundlers emit `<anonymous>` frames, so the regex matched page
 * code too, and the field was wrong on two of three.
 *
 * With raw frames, run #17 attributed them beyond argument:
 *   Fuji  -> Object.switchChain (app.aave.com/_next/.../_app-*.js)
 *   84532 -> eval (eval at evaluate ...)
 *
 * Attribution is a judgement. The evidence for it belongs in the log, not
 * pre-chewed into one word by a regex.
 */
export async function readChainLog(page: Page, label: string): Promise<ChainLogEntry[]> {
  const log = (await page.evaluate(`window.__chainLog || []`).catch(() => [])) as ChainLogEntry[]

  console.log(`[chain-order] ${label} — ${log.length} chain request(s)`)
  for (const e of log) {
    // The ANSWER is printed on the same line as the ask. Run #21 spent a whole
    // analysis on "both columns got the same requests" without being able to say
    // what came back — which is where the difference actually lived.
    const answer =
      e.outcome === 'rejected'
        ? `REJECTED code=${e.code ?? '?'}${e.message ? ` "${e.message.slice(0, 60)}"` : ''}`
        : e.outcome === 'resolved'
          ? 'resolved'
          : 'PENDING (never settled)'
    console.log(
      `  +${String(e.ms).padStart(6)}ms  ${e.method}  chainId=${e.chainId ?? '-'}` +
        `${e.chainName ? ` (${e.chainName})` : ''}  rdns=${e.rdns}  → ${answer}`,
    )
    for (const frame of e.stackHead ?? []) console.log(`             ${frame}`)
  }
  if (!log.length) {
    console.log('  (none — either the hook was not installed via addInitScript, or nothing asked)')
  }
  return log
}
