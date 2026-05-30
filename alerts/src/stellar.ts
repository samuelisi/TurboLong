/**
 * Soroban RPC calls to fetch Blend pool reserve data and compute APY.
 *
 * Ported from frontend/src/blend.ts — minimal subset needed for the cron job.
 * No Stellar SDK dependency: we call Soroban RPC directly via fetch().
 */

// ── Constants ────────────────────────────────────────────────────────────────

const RPC_URL = "https://soroban-rpc.creit.tech/";
const RATE_DEC = 1_000_000_000_000;
const SCALAR   = 10_000_000;
const SECONDS_PER_YEAR = 31_536_000;

// Null account for read-only simulations (valid on any Stellar network)
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// ── Pool definitions (mainnet only — active pools) ───────────────────────────

export interface PoolDef {
  id: string;
  name: string;
  oracleId: string;
  oracleDec: number;
  backstopFP: number; // 1e7 fixed-point
  assets: { id: string; symbol: string; reserveIndex: number }[];
}

export const POOLS: PoolDef[] = [
  {
    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
    name: "Etherfuse",
    oracleId: "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS",
    oracleDec: 1e14,
    backstopFP: 2_000_000,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",     reserveIndex: 0 },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC",    reserveIndex: 1 },
      { id: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", symbol: "CETES",   reserveIndex: 2 },
      { id: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", symbol: "USTRY",   reserveIndex: 3 },
      { id: "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS", symbol: "TESOURO", reserveIndex: 4 },
    ],
  },
  {
    id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    name: "Fixed",
    oracleId: "CCVTVW2CVA7JLH4ROQGP3CU4T3EXVCK66AZGSM4MUQPXAI4QHCZPOATS",
    oracleDec: 1e7,
    backstopFP: 2_000_000,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",  reserveIndex: 0 },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC", reserveIndex: 1 },
      { id: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", symbol: "EURC", reserveIndex: 2 },
    ],
  },
];

// Valid leverage brackets
export const LEVERAGE_BRACKETS = [2, 3, 5, 8, 10];

// Map pool contract IDs to names for email display
export const POOL_NAMES: Record<string, string> = {};
for (const p of POOLS) POOL_NAMES[p.id] = p.name;

// ── Soroban XDR helpers ──────────────────────────────────────────────────────
// Minimal XDR encoding/decoding — avoids pulling in the full Stellar SDK.

/** Encode a Stellar address as an ScVal (ScAddress::Account or ::Contract). */
function addressToScVal(addr: string): string {
  // We use the JSON representation that soroban-rpc accepts
  return JSON.stringify({ type: "Address", value: addr });
}

/** Build XDR for an invoke-contract call using the null account. */
function buildInvokeXdr(contractId: string, method: string, args: any[]): string {
  return encodeInvokeTransaction(NULL_ACCOUNT, NETWORK_PASSPHRASE, contractId, method, args);
}

/** Build a simulateTransaction JSON-RPC request body. */
function buildSimulateBody(contractId: string, method: string, args: any[]): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: {
      transaction: buildInvokeXdr(contractId, method, args),
    },
  };
}

// We need proper XDR encoding. Since we can't use the SDK in a worker easily,
// we'll use the soroban-rpc's native JSON interface via stellar-sdk-like encoding.
// Actually, the simplest approach: build a minimal transaction envelope in base64.

// For a Cloudflare Worker, we'll use a simpler approach: fetch raw contract data
// via getContractData or use the soroban-rpc simulateTransaction with proper XDR.
// Let's use a lightweight XDR approach.

import { encodeInvokeTransaction, decodeSimResult, decodeXdrValue } from "./xdr.ts";

export interface ReserveRates {
  netSupplyApr: number;
  netBorrowCost: number;
  interestSupplyApr: number;
  interestBorrowApr: number;
  blndSupplyApr: number;
  blndBorrowApr: number;
}

/** Simulate a contract call and return the decoded result. */
async function simulate(contractId: string, method: string, args: any[]): Promise<any> {
  const txXdr = encodeInvokeTransaction(
    NULL_ACCOUNT,
    NETWORK_PASSPHRASE,
    contractId,
    method,
    args,
  );

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: { transaction: txXdr },
    }),
  });

  const json = await res.json() as any;
  if (!json.result?.results?.[0]?.xdr) return null;
  return decodeSimResult(json.result.results[0].xdr);
}

/** Fetch BLND price from CoinGecko (cached per invocation). */
let _blndPrice: number | null = null;
async function fetchBlndPrice(): Promise<number> {
  if (_blndPrice !== null) return _blndPrice;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=blend&vs_currencies=usd",
      { signal: AbortSignal.timeout(6000) },
    );
    if (res.ok) {
      const data = await res.json() as any;
      _blndPrice = data["blend"]?.usd ?? 0;
      return _blndPrice!;
    }
  } catch { /* fall through */ }
  _blndPrice = 0;
  return 0;
}

/** Fetch reserve stats for a single asset in a pool and compute APR. */
export async function fetchReserveRates(pool: PoolDef, asset: { id: string; symbol: string; reserveIndex: number }): Promise<ReserveRates | null> {
  try {
    const [reserveRaw, priceRaw, supplyEmissions, borrowEmissions, blndPrice] = await Promise.all([
      simulate(pool.id, "get_reserve", [{ type: "address", value: asset.id }]),
      simulate(pool.oracleId, "lastprice", [{ type: "vec", value: [{ type: "symbol", value: "Stellar" }, { type: "address", value: asset.id }] }]),
      simulate(pool.id, "get_reserve_emissions", [{ type: "u32", value: asset.reserveIndex * 2 + 1 }]),
      simulate(pool.id, "get_reserve_emissions", [{ type: "u32", value: asset.reserveIndex * 2 }]),
      fetchBlndPrice(),
    ]);

    if (!reserveRaw) return null;

    const priceUsd = priceRaw?.price != null
      ? Number(BigInt(priceRaw.price)) / pool.oracleDec
      : 0;

    const bRate   = BigInt(reserveRaw.data?.b_rate ?? RATE_DEC);
    const dRate   = BigInt(reserveRaw.data?.d_rate ?? RATE_DEC);
    const bSupply = BigInt(reserveRaw.data?.b_supply ?? 0);
    const dSupply = BigInt(reserveRaw.data?.d_supply ?? 0);

    const totalSupply = Number(bSupply * BigInt(Math.round(Number(bRate))) / BigInt(RATE_DEC)) / SCALAR;
    const totalBorrow = Number(dSupply * BigInt(Math.round(Number(dRate))) / BigInt(RATE_DEC)) / SCALAR;

    // ── Interest rate formula (Blend v2) ──
    const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;

    const rBase_fp   = reserveRaw.config?.r_base   ?? 300_000;
    const rOne_fp    = reserveRaw.config?.r_one     ?? 400_000;
    const rTwo_fp    = reserveRaw.config?.r_two     ?? 1_200_000;
    const rThree_fp  = reserveRaw.config?.r_three   ?? 50_000_000;
    const utilOpt_fp = reserveRaw.config?.util       ?? 5_000_000;
    const irMod_fp   = reserveRaw.data?.ir_mod != null ? Number(BigInt(reserveRaw.data.ir_mod)) : 1_000_000;

    const curUtil_fp  = Math.round(util * SCALAR);
    const FIXED_95PCT = 9_500_000;
    const BACKSTOP_FP = pool.backstopFP;

    let baseRate_fp: number;
    if (curUtil_fp <= utilOpt_fp) {
      baseRate_fp = rBase_fp + Math.ceil(rOne_fp * curUtil_fp / utilOpt_fp);
    } else if (curUtil_fp <= FIXED_95PCT) {
      const slope = Math.ceil((curUtil_fp - utilOpt_fp) * SCALAR / (FIXED_95PCT - utilOpt_fp));
      baseRate_fp = rBase_fp + rOne_fp + Math.ceil(rTwo_fp * slope / SCALAR);
    } else {
      const slope = Math.ceil((curUtil_fp - FIXED_95PCT) * SCALAR / (SCALAR - FIXED_95PCT));
      baseRate_fp = rBase_fp + rOne_fp + rTwo_fp + Math.ceil(rThree_fp * slope / SCALAR);
    }

    const curIr_fp = Math.ceil(baseRate_fp * irMod_fp / SCALAR);
    const interestBorrowApr = (curIr_fp / SCALAR) * 100;

    const supplyCapture_fp  = Math.floor((SCALAR - BACKSTOP_FP) * curUtil_fp / SCALAR);
    const interestSupplyApr = (Math.floor(curIr_fp * supplyCapture_fp / SCALAR) / SCALAR) * 100;

    // BLND emissions
    const supplyEps = supplyEmissions?.eps != null ? Number(BigInt(supplyEmissions.eps)) : 0;
    const borrowEps = borrowEmissions?.eps != null ? Number(BigInt(borrowEmissions.eps)) : 0;

    const supplyBlndYr = supplyEps * SECONDS_PER_YEAR / SCALAR / SCALAR;
    const borrowBlndYr = borrowEps * SECONDS_PER_YEAR / SCALAR / SCALAR;

    const totalSupplyUsd = totalSupply * priceUsd;
    const totalBorrowUsd = totalBorrow * priceUsd;

    const blndSupplyApr = totalSupplyUsd > 0 ? (supplyBlndYr * blndPrice / totalSupplyUsd) * 100 : 0;
    const blndBorrowApr = totalBorrowUsd > 0 ? (borrowBlndYr * blndPrice / totalBorrowUsd) * 100 : 0;

    return {
      netSupplyApr:     interestSupplyApr + blndSupplyApr,
      netBorrowCost:    interestBorrowApr - blndBorrowApr,
      interestSupplyApr,
      interestBorrowApr,
      blndSupplyApr,
      blndBorrowApr,
    };
  } catch (e) {
    console.error(`fetchReserveRates failed for ${asset.symbol} on ${pool.name}:`, e);
    return null;
  }
}

/** Compute net APY at a given leverage. */
export function computeNetApy(rates: ReserveRates, leverage: number): number {
  return rates.netSupplyApr * leverage - rates.netBorrowCost * (leverage - 1);
}
