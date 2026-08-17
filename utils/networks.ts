/**
 * The network under test.
 *
 * Base Sepolia isn't a preference — it's the only testnet market Aave still
 * runs. MetaMask doesn't ship with it, so the dApp has to ask the wallet to add
 * it and switch, and we approve that (see `ensureNetwork` in helpers.ts).
 */
export const BASE_SEPOLIA = {
  chainIdHex: '0x14a34', // 84532
  chainId: 84532,
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // NOT the official https://sepolia.base.org — MetaMask's requests make it
  // return `failed to decode param in array[0] invalid JSON input` (-32603) and
  // the transaction never broadcasts. It looks exactly like a contract revert
  // ("Transaction failed" in the dApp) but it's the RPC choking on the payload.
  rpcUrls: [process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia-rpc.publicnode.com'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
} as const

/**
 * Ethereum Sepolia — the SECOND chain, added 2026-08-16.
 *
 * Why a second chain at all: every verdict so far was measured on one chain
 * through one dApp, so "the wallet does X" and "Aave's config does X" were not
 * separable (see docs/findings/aave-base-sepolia-wagmi-fuji.md). A second chain
 * is the axis that tells wallet behaviour apart from one chain's quirks — and
 * coverage across chains is exactly what the WalletConnect QA feedback named as
 * the thing worth having.
 *
 * Sepolia specifically: it is the testnet wallets are most likely to ship
 * built-in, so `wallet_switchEthereumChain` should succeed WITHOUT an add — which
 * makes it the natural control against Base Sepolia, where MetaMask must add the
 * network first. Those are two genuinely different wallet code paths, and the
 * difference between them is a measurement, not a nuisance.
 *
 * No funds needed: connect and personal_sign are free. Nothing here spends gas.
 */
export const ETHEREUM_SEPOLIA = {
  chainIdHex: '0xaa36a7', // 11155111
  chainId: 11155111,
  chainName: 'Ethereum Sepolia',
  // `SepoliaETH`, not `ETH` — and this is a real constraint, not a preference.
  //
  // Run #21: `wallet_addEthereumChain` was rejected with
  //   -32602 "nativeCurrency.symbol does not match currency symbol for a network
  //           the user already has added with the same chainId. Received: ETH"
  // MetaMask ships Sepolia with the symbol `SepoliaETH`, and refuses to add a
  // chain whose symbol disagrees with a built-in entry of the same id. So the
  // cell failed and the wallet sat on mainnet — our config bug, not a wallet one.
  nativeCurrency: { name: 'Ether', symbol: 'SepoliaETH', decimals: 18 },
  rpcUrls: [process.env.ETHEREUM_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
} as const

/** The shape every chain in the registry satisfies. */
export type Chain = {
  readonly chainIdHex: string
  readonly chainId: number
  readonly chainName: string
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number }
  readonly rpcUrls: readonly string[]
  readonly blockExplorerUrls: readonly string[]
}

/**
 * Every chain a cell may be measured against, keyed by the slug that appears in
 * MATRIX verdict lines (`chain=base-sepolia`). Adding a chain to the grid should
 * be an entry here plus a spec parameter — never a new integration.
 */
export const CHAINS: Record<string, Chain> = {
  'base-sepolia': BASE_SEPOLIA,
  'ethereum-sepolia': ETHEREUM_SEPOLIA,
}

/**
 * Params shape accepted by `wallet_addEthereumChain`.
 *
 * Defaults to Base Sepolia so every existing caller is unchanged.
 */
export function addChainParams(chain: Chain = BASE_SEPOLIA) {
  const { chainIdHex, chainName, nativeCurrency, rpcUrls, blockExplorerUrls } = chain
  return {
    chainId: chainIdHex,
    chainName,
    nativeCurrency: { ...nativeCurrency },
    rpcUrls: [...rpcUrls],
    blockExplorerUrls: [...blockExplorerUrls],
  }
}
