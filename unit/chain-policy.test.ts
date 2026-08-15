/**
 * Unit tests for the pure chain-approval decision — no browser, run in ms.
 *
 *   npx tsx tests/unit/chain-policy.test.ts
 *   (or: pnpm run test:unit)
 *
 * WHY A UNIT TEST EXISTS FOR THIS AND NOTHING ELSE
 * `chain-policy.ts` is the one module the whole matrix declares load-bearing:
 * "ANY harness policy that can change a verdict must be identical across every
 * column." A policy that important should not be exercised only as a side effect
 * of a 13-minute wallet run that needs a testnet, an extension cache and CI.
 *
 * `decideChainDialog` and `looksLikeChainDialog` are pure functions, so they can
 * be pinned directly against the exact dialog wording real wallets render. Run
 * #19 proved why that matters: the detector matched Rabby and silently missed
 * MetaMask, and no unit test was there to catch a guard that had gone inert.
 *
 * These cases are built from OBSERVED data where we have it (the Rabby Avalanche
 * Fuji dialog, whose inputs are on record in matrix-out-ci/.../run.log) and are
 * marked PENDING where we do not (MetaMask 13.39.1 wording — capture it with
 * `pnpm run probe:mm:chain`, then turn the pending block into assertions).
 */
import assert from 'node:assert/strict'
import {
  looksLikeChainDialog,
  decideChainDialog,
  TARGET_CHAIN_ID,
  TARGET_FINGERPRINT,
  type ChainDialogReading,
} from '../utils/chain-policy'

// --- tiny runner (no dependency on a test framework) -----------------------
let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`)
  }
}

// A full reading, overridable per case. Defaults describe a painted chain dialog
// so each test only states what it cares about.
function reading(partial: Partial<ChainDialogReading> = {}): ChainDialogReading {
  return {
    painted: true,
    isChainDialog: true,
    haystack: '',
    inputs: [],
    sawChainId: null,
    ...partial,
  }
}

// --- observed fixtures ------------------------------------------------------
// Rabby's real Avalanche Fuji add-network dialog. Inputs are verbatim from the
// CI run log; the text is Rabby's known heading.
const RABBY_FUJI_INPUTS = [
  '43113',
  'Avalanche Fuji',
  'https://api.avax-test.network/ext/bc/C/rpc',
  'AVAX',
  'https://testnet.snowtrace.io',
]
const RABBY_FUJI_TEXT = 'Add Custom Network to Rabby\nAllow this site to add a network?\nAvalanche Fuji'
const RABBY_FUJI_HAYSTACK = [RABBY_FUJI_TEXT, ...RABBY_FUJI_INPUTS].join(' | ')

// MetaMask 13.39.1's real add-network dialog, captured verbatim by
// `pnpm run probe:mm:chain` (2026-08-15). Note what is NOT here: no chain id,
// no currency symbol, no <input> values — only the name and the RPC host. This
// is the dialog that classified `not-a-chain-dialog` and got Fuji approved.
const MM_FUJI_HAYSTACK =
  'Add Avalanche Fuji\n\nA site is suggesting additional network details.\n\n' +
  'Request from\n\nH\n\ndapp.mm-chain-probe.local\n\nNetwork\n\nA\n\nAvalanche Fuji\n\n' +
  'RPC\n\napi.avax-test.network/ext/bc/C/rpc\n\n' +
  'Beware of network scams and security risks.\n\nCancel\nConfirm'

// The Base Sepolia dialog MetaMask shows for OUR add-chain request: the same
// captured template with the network name and RPC substituted (the RPC host is
// taken from the live fingerprint so this stays correct under an env override).
// The whole point of the case: it carries NO chain id, exactly like the real
// one, so it exercises the RPC-host approval path.
const TARGET_RPC_HOST = TARGET_FINGERPRINT.rpcHosts[0] ?? 'base-sepolia-rpc.publicnode.com'
const MM_BASE_HAYSTACK =
  'Add Base Sepolia\n\nA site is suggesting additional network details.\n\n' +
  `Request from\n\nH\n\ndapp.mm-chain-probe.local\n\nNetwork\n\nB\n\nBase Sepolia\n\n` +
  `RPC\n\n${TARGET_RPC_HOST}\n\n` +
  'Beware of network scams and security risks.\n\nCancel\nConfirm'

console.log('chain-policy — detector (looksLikeChainDialog)')

check('TARGET_CHAIN_ID is Base Sepolia (84532)', () => {
  assert.equal(TARGET_CHAIN_ID, 84532)
})

check('matches Rabby "Add Custom Network" wording', () => {
  assert.equal(looksLikeChainDialog(RABBY_FUJI_TEXT), true)
})

check('matches a plain "Add network" heading', () => {
  assert.equal(looksLikeChainDialog('Add network'), true)
})

check('matches "Allow this site to switch the network"', () => {
  assert.equal(looksLikeChainDialog('Allow this site to switch the network?'), true)
})

check('a transaction confirm is NOT a chain dialog (even with a stray year)', () => {
  // "2026" here is the same shape that fooled sawChainId in run #19 — a number
  // on the screen that is not a chain id. It must not trip the detector.
  assert.equal(
    looksLikeChainDialog('Confirm\nSupply 1.0 USDC\nNetwork fee 0.0002 ETH\n© 2026'),
    false,
  )
})

check('a connect/permission prompt is NOT a chain dialog', () => {
  // The connect permission is approved elsewhere; it must fall through as
  // not-a-chain-dialog, NOT be caught by the chain guard.
  assert.equal(
    looksLikeChainDialog('Connect with MetaMask\nThis site wants to see your accounts'),
    false,
  )
})

console.log('chain-policy — decision (decideChainDialog)')

check('unpainted dialog declines (unreadable is never approved)', () => {
  const v = decideChainDialog(reading({ painted: false, isChainDialog: false }))
  assert.equal(v.decision, 'decline')
})

check('painted non-chain screen returns not-a-chain-dialog', () => {
  const v = decideChainDialog(reading({ isChainDialog: false, haystack: 'Confirm | Supply' }))
  assert.equal(v.decision, 'not-a-chain-dialog')
})

check('Rabby Fuji dialog is DECLINED against Base Sepolia target', () => {
  const v = decideChainDialog(
    reading({ haystack: RABBY_FUJI_HAYSTACK, inputs: RABBY_FUJI_INPUTS, sawChainId: '43113' }),
  )
  assert.equal(v.decision, 'decline')
  assert.match(v.reason, /want 84532/)
})

check('target offered in DECIMAL (84532) is approved', () => {
  const v = decideChainDialog(
    reading({ haystack: 'Add network | 84532 | Base Sepolia | https://sepolia.base.org | ETH' }),
  )
  assert.equal(v.decision, 'approve')
})

check('target offered in HEX only (0x14a34) is approved  [the run #19 hex risk]', () => {
  // The regression guard: before hex-awareness this DECLINED the correct chain
  // whenever a wallet printed the id in hex and no decimal appeared.
  const v = decideChainDialog(
    reading({ haystack: 'Allow this site to switch the network? | Base Sepolia | Chain ID 0x14a34 | ETH' }),
  )
  assert.equal(v.decision, 'approve')
})

check('decimal match is BOUNDED — 845321 does not satisfy 84532', () => {
  const v = decideChainDialog(reading({ haystack: 'Chain ID 845321 | Some Other Chain' }))
  assert.equal(v.decision, 'decline')
})

check('hex match is BOUNDED — 0x14a340 does not satisfy 0x14a34', () => {
  const v = decideChainDialog(reading({ haystack: 'Chain 0x14a340 | Some Other Chain' }))
  assert.equal(v.decision, 'decline')
})

console.log('chain-policy — MetaMask 13.39.1 (captured 2026-08-15)')

check('detector matches MetaMask add-network wording', () => {
  assert.equal(looksLikeChainDialog(MM_FUJI_HAYSTACK), true)
})

check('MetaMask Fuji dialog is DECLINED (no target id, no target RPC on screen)', () => {
  const v = decideChainDialog(reading({ haystack: MM_FUJI_HAYSTACK }))
  assert.equal(v.decision, 'decline')
})

check('MetaMask Base Sepolia is APPROVED via RPC host, though it shows no id', () => {
  // The regression id-only matching would have caused: MetaMask prints no chain
  // id, so 84532/0x14a34 are both absent — approval MUST come from the RPC host.
  const v = decideChainDialog(reading({ haystack: MM_BASE_HAYSTACK }))
  assert.equal(v.decision, 'approve')
})

check('TARGET_FINGERPRINT carries at least one non-empty RPC host', () => {
  assert.ok(TARGET_FINGERPRINT.rpcHosts.length > 0)
  assert.ok(TARGET_FINGERPRINT.rpcHosts.every((h) => h.length > 0))
})

console.log('')
if (failures) {
  console.log(`FAILED — ${failures} assertion(s)`)
  process.exit(1)
}
console.log('OK — all chain-policy assertions passed')
