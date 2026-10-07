import { mainnet } from "viem/chains";

/**
 * Ethereum mainnet (chain id 1) constants used by the skill helpers.
 *
 * - Every contract address below has bytecode on Ethereum mainnet; QuoterV2 and SwapRouter02 point at the Uniswap
 *   V3 factory listed here.
 * - Tokenized stocks are Ondo Global Markets tokens ("…on", 18 decimals), each with a Uniswap V3 pool against USDC.
 *   They track the listed share; they are not the share. There is no on-chain price feed for them here: the outside
 *   reference is the listed share's last price (see `src/share.ts`).
 * - ETH is compared with the Chainlink ETH/USD feed.
 */
export const ETHEREUM = {
  chainId: 1,
  name: "Ethereum",
  rpc: "https://ethereum-rpc.publicnode.com",
  explorer: "https://etherscan.io",
  /** Average block time; used to turn block windows into hours. */
  blockTimeS: 12,
} as const;

/** viem's mainnet definition (it already carries Multicall3). */
export const ethereum = mainnet;

export type Address = `0x${string}`;

export const USDC = {
  symbol: "USDC",
  name: "USD Coin",
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  decimals: 6,
} as const;

/** WETH9 used by the Uniswap router. The deepest WETH/USDC V3 pool is the 0.05% (fee 500) tier. */
export const WETH = {
  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
  decimals: 18,
  fee: 500,
} as const;

export const UNISWAP_V3 = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Address,
  swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address,
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address,
} as const;

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

/** Chainlink ETH/USD (8 decimals): the outside reference for ETH quotes. */
export const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as Address;
export const FEED_DECIMALS = 8;

export const STOCK_DECIMALS = 18;

export type StockToken = {
  /** The listed share's ticker, used as the symbol everywhere (NVDA, not NVDAon). */
  symbol: string;
  /** The token's own on-chain symbol. */
  token: string;
  name: string;
  address: Address;
  /** Uniswap V3 fee tier of the token's USDC pool; absent when the token has no V3 pool. */
  fee?: 500 | 3000 | 10000;
  /** Ticker of the listed share to compare against; null when there is none (a private company). */
  ticker: string | null;
};

export const STOCK_TOKENS: readonly StockToken[] = [
  {
    symbol: "NVDA",
    token: "NVDAon",
    name: "NVIDIA",
    address: "0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE",
    fee: 3000,
    ticker: "NVDA",
  },
  {
    symbol: "SLV",
    token: "SLVon",
    name: "iShares Silver Trust",
    address: "0xF3e4872e6a4cF365888D93b6146a2bAA7348F1A4",
    fee: 10000,
    ticker: "SLV",
  },
  {
    symbol: "TSLA",
    token: "TSLAon",
    name: "Tesla",
    address: "0xf6b1117ec07684D3958caD8BEb1b302bfD21103f",
    fee: 10000,
    ticker: "TSLA",
  },
  {
    symbol: "SPY",
    token: "SPYon",
    name: "SPDR S&P 500 ETF",
    address: "0xFeDC5f4a6c38211c1338aa411018DFAf26612c08",
    fee: 3000,
    ticker: "SPY",
  },
  {
    symbol: "GOOGL",
    token: "GOOGLon",
    name: "Alphabet",
    address: "0xbA47214eDd2bb43099611b208f75E4b42FDcfEDc",
    fee: 10000,
    ticker: "GOOGL",
  },
  {
    symbol: "AAPL",
    token: "AAPLon",
    name: "Apple",
    address: "0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c",
    fee: 10000,
    ticker: "AAPL",
  },
  {
    // A private company: there is no listed share to compare against.
    symbol: "SPCX",
    token: "SPCXon",
    name: "SpaceX",
    address: "0xc9eef266834730340A55B6CC24621B31BAF55581",
    fee: 10000,
    ticker: null,
  },
];

/** Look up a tokenized stock by share ticker or token symbol (case-insensitive). */
export const stockToken = (symbol: string): StockToken | undefined => {
  const s = symbol.toUpperCase();
  return STOCK_TOKENS.find((t) => t.symbol === s || t.token.toUpperCase() === s);
};
