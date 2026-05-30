/**
 * Blend pool interactions — supports multiple pools (Etherfuse, Fixed, YieldBlox).
 */

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Networks,
  nativeToScVal,
  Operation,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// ── Types & constants ────────────────────────────────────────────────────────

export type NetworkMode = "mainnet" | "testnet";

// Token rate scale (b_rate / d_rate): 12 decimal places
const RATE_DEC   = 1_000_000_000_000n;
const SCALAR     = 10_000_000n;
const SCALAR_F   = 10_000_000;
const SECONDS_PER_YEAR = 31_536_000;

export const SUPPLY_COLLATERAL  = 2;
export const WITHDRAW_COLLATERAL = 3;
export const REPAY  = 5;
export const BORROW = 4;

// Null account: valid on any network, sequence=0 — used for read-only simulations
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface PoolDef {
  id:         string;   // pool contract address
  name:       string;   // display name
  oracleId:   string;   // oracle contract address
  oracleDec:  number;   // oracle price divisor (e.g. 1e14 or 1e7)
  backstopFP: number;   // backstop take rate in 1e7 fixed point (e.g. 2_000_000 = 20%)
  status:     number;   // 1 = active, 4 = admin frozen
  assetIds:   string[]; // asset contract IDs in reserve order
}

interface AssetMeta {
  symbol:   string;
  name:     string;
  decimals: number;
  cFactor:  number; // default collateral factor
  maxUtil:  number; // default max utilisation
  fallbackPrice?: number; // USD price fallback when oracle is unavailable
}

interface NetworkConfig {
  passphrase:    string;
  rpcUrl:        string;
  horizonUrl:    string;
  blndId:        string;
  blndClassic:   Asset;
  pools:         PoolDef[];
  assetMetadata: Record<string, AssetMeta>;
  classicAssets: Record<string, Asset>;
}

// ── Mainnet configuration ────────────────────────────────────────────────────

const MAINNET_CONFIG: NetworkConfig = {
  passphrase:  Networks.PUBLIC,
  rpcUrl:      "https://soroban-rpc.creit.tech/",
  horizonUrl:  "https://horizon.stellar.org",
  blndId:      "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
  blndClassic: new Asset("BLND", "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY"),
  pools: [
    {
      id:        "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
      name:      "Etherfuse",
      oracleId:  "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS",
      oracleDec: 1e14,
      backstopFP: 2_000_000,
      status:    1,
      assetIds: [
        "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", // XLM
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
        "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", // CETES
        "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", // USTRY
        "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS", // TESOURO
      ],
    },
    {
      id:        "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
      name:      "Fixed",
      oracleId:  "CCVTVW2CVA7JLH4ROQGP3CU4T3EXVCK66AZGSM4MUQPXAI4QHCZPOATS",
      oracleDec: 1e7,
      backstopFP: 2_000_000,
      status:    1,
      assetIds: [
        "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", // XLM
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
        "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", // EURC
      ],
    },
    {
      id:        "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
      name:      "YieldBlox",
      oracleId:  "CD74A3C54EKUVEGUC6WNTUPOTHB624WFKXN3IYTFJGX3EHXDXHCYMXXR",
      oracleDec: 1e7,
      backstopFP: 2_000_000,
      status:    1,
      assetIds: [
        "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", // XLM
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
        "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", // EURC
        "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK", // AQUA
        "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE", // USDGLO
        "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", // USTRY
        "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", // CETES
        "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2", // PYUSD
      ],
    },
  ],
  assetMetadata: {
    "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA": {
      symbol: "XLM", name: "Stellar Lumens",   decimals: 7, cFactor: 0.75, maxUtil: 0.70,
    },
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75": {
      symbol: "USDC", name: "USD Coin",          decimals: 7, cFactor: 0.95, maxUtil: 0.95,
    },
    "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV": {
      symbol: "CETES", name: "CETES",             decimals: 7, cFactor: 0.80, maxUtil: 0.90,
    },
    "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR": {
      symbol: "USTRY", name: "US Treasury",       decimals: 7, cFactor: 0.90, maxUtil: 0.90,
    },
    "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS": {
      symbol: "TESOURO", name: "Brazilian Treasury", decimals: 7, cFactor: 0.80, maxUtil: 0.90,
    },
    "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV": {
      symbol: "EURC", name: "Euro Coin",           decimals: 7, cFactor: 0.90, maxUtil: 0.90,
    },
    "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK": {
      symbol: "AQUA", name: "Aquarius",            decimals: 7, cFactor: 0.00, maxUtil: 0.80,
    },
    "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE": {
      symbol: "USDGLO", name: "Global Dollar",     decimals: 7, cFactor: 0.90, maxUtil: 0.90,
    },
    "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2": {
      symbol: "PYUSD", name: "PayPal USD",          decimals: 7, cFactor: 0.90, maxUtil: 0.90,
    },
  },
  classicAssets: {
    "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA": Asset.native(),
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75": new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
    "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV": new Asset("EURC", "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2"),
    "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK": new Asset("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA"),
    "CB226ZOEYXTBPD3QEGABTJYSKZVBP2PASEISLG3SBMTN5CE4QZUVZ3CE": new Asset("USDGLO", "GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV"),
    "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR": new Asset("USTRY", "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC"),
    "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV": new Asset("CETES", "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC"),
    "CCCRWH6Q3FNP3I2I57BDLM5AFAT7O6OF6GKQOC6SSJNDAVRZ57SPHGU2": new Asset("PYUSD", "GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5"),
    "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS": new Asset("TESOURO", "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC"),
  },
};

// ── Testnet configuration ────────────────────────────────────────────────────

const TESTNET_P1_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TESTNET_P2_ISSUER     = "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";
const TESTNET_CETES_ISSUER  = "GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4";

const TESTNET_CONFIG: NetworkConfig = {
  passphrase:  Networks.TESTNET,
  rpcUrl:      "https://soroban-testnet.stellar.org",
  horizonUrl:  "https://horizon-testnet.stellar.org",
  blndId:      "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",
  blndClassic: new Asset("BLND", TESTNET_P1_USDC_ISSUER), // placeholder
  pools: [
    {
      id:        "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW",
      name:      "RegionalStarterPack",
      oracleId:  "CCBTMXJW4BCEX2YCCOHQ5RX2C5CS6U4FZAYXFAL7LCB7GSAIHYVW4QLE",
      oracleDec: 1e7,
      backstopFP: 5_000_000,
      status:    1,
      assetIds: [
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // XLM
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // USDC
        "CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC", // CETES
      ],
    },
    {
      id:        "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
      name:      "TestnetV2",
      oracleId:  "CAZOKR2Y5E2OSWSIBRVZMJ47RUTQPIGVWSAQ2UISGAVC46XKPGDG5PKI",
      oracleDec: 1e7,
      backstopFP: 1_000_000,
      status:    1,
      assetIds: [
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", // XLM
        "CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE", // wETH
        "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI", // wBTC
        "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU", // USDC
      ],
    },
  ],
  assetMetadata: {
    // Shared
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC": {
      symbol: "XLM", name: "Stellar Lumens", decimals: 7, cFactor: 0.90, maxUtil: 0.95,
    },
    // Pool 1 (RegionalStarterPack)
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA": {
      symbol: "USDC", name: "USD Coin", decimals: 7, cFactor: 0.98, maxUtil: 0.98,
    },
    "CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC": {
      symbol: "CETES", name: "CETES", decimals: 7, cFactor: 0.98, maxUtil: 0.98,
    },
    // Pool 2 (TestnetV2)
    "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU": {
      symbol: "USDC", name: "USD Coin", decimals: 7, cFactor: 0.95, maxUtil: 0.95,
    },
    "CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE": {
      symbol: "wETH", name: "Wrapped Ether", decimals: 7, cFactor: 0.85, maxUtil: 0.95,
    },
    "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI": {
      symbol: "wBTC", name: "Wrapped Bitcoin", decimals: 7, cFactor: 0.90, maxUtil: 0.95,
    },
  },
  classicAssets: {
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC": Asset.native(),
    "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA": new Asset("USDC", TESTNET_P1_USDC_ISSUER),
    "CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC": new Asset("CETES", TESTNET_CETES_ISSUER),
    "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU": new Asset("USDC", TESTNET_P2_ISSUER),
    "CAZAQB3D7KSLSNOSQKYD2V4JP5V2Y3B4RDJZRLBFCCIXDCTE3WHSY3UE": new Asset("wETH", TESTNET_P2_ISSUER),
    "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI": new Asset("wBTC", TESTNET_P2_ISSUER),
  },
};

// ── Active network state ─────────────────────────────────────────────────────

let _activeNet: NetworkMode = "mainnet";
let _cfg: NetworkConfig = MAINNET_CONFIG;

export function getActiveNetwork(): NetworkMode { return _activeNet; }
export function getNetworkPassphrase(): string { return _cfg.passphrase; }
export function getHorizonUrl(): string { return _cfg.horizonUrl; }

export function setNetwork(net: NetworkMode) {
  _activeNet = net;
  _cfg = net === "testnet" ? TESTNET_CONFIG : MAINNET_CONFIG;
  // Rebuild RPC/Horizon clients
  server  = new SorobanRpc.Server(_cfg.rpcUrl);
  horizon = new Horizon.Server(_cfg.horizonUrl);
  // Reset BLND price cache
  _blndPriceCache = null;
}

/** Exported getters for active config — used by main.ts and other modules */
export function getKnownPools(): PoolDef[] { return _cfg.pools; }
export function getBlndId(): string { return _cfg.blndId; }

// ── Asset registry ────────────────────────────────────────────────────────────

export interface AssetInfo {
  id:           string;   // contract address
  symbol:       string;
  name:         string;
  decimals:     number;
  reserveIndex: number;   // index in the pool's reserve list
  supplyTokenId: number;  // reserve_index * 2 + 1
  borrowTokenId: number;  // reserve_index * 2
  cFactor:      number;   // 0..1, set after fetching
  maxUtil:      number;   // 0..1
}

/** Build the AssetInfo array for a given pool from active network's asset metadata. */
export function getPoolAssets(pool: PoolDef): AssetInfo[] {
  return pool.assetIds.map((id, idx) => {
    const meta = _cfg.assetMetadata[id];
    if (!meta) throw new Error(`Unknown asset id: ${id} (network: ${_activeNet})`);
    return {
      id,
      symbol:        meta.symbol,
      name:          meta.name,
      decimals:      meta.decimals,
      reserveIndex:  idx,
      supplyTokenId: idx * 2 + 1,
      borrowTokenId: idx * 2,
      cFactor:       meta.cFactor,
      maxUtil:       meta.maxUtil,
    };
  });
}

// ── RPC ───────────────────────────────────────────────────────────────────────

export let server  = new SorobanRpc.Server(MAINNET_CONFIG.rpcUrl);
let horizon = new Horizon.Server(MAINNET_CONFIG.horizonUrl);

// ── ScVal helpers ─────────────────────────────────────────────────────────────

export function i128ToScVal(n: bigint): xdr.ScVal {
  const hi = n < 0n ? ~((-n - 1n) >> 64n) & 0xFFFFFFFFFFFFFFFFn : n >> 64n;
  const lo = n & 0xFFFFFFFFFFFFFFFFn;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
  );
}

/** Encode oracle Asset::Stellar(addr) variant. */
function assetScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stellar"),
    new Address(contractId).toScVal(),
  ]);
}

function buildRequest(assetId: string, amount: bigint, requestType: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: new Address(assetId).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"),  val: i128ToScVal(amount) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: nativeToScVal(requestType, { type: "u32" }) }),
  ]);
}

function buildRequestsVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

// ── RPC retry helper ──────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      console.warn(`RPC call failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── Simulate helper ───────────────────────────────────────────────────────────

// Read-only simulation: uses the null account so no getAccount() RPC call is needed.
// Contract call arguments (e.g. user address) are still passed via op parameters.
async function simulate(op: xdr.Operation): Promise<any> {
  try {
    const acc = new Account(NULL_ACCOUNT, "0");
    const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: _cfg.passphrase })
      .addOperation(op).setTimeout(30).build();
    const sim = await withRetry(() => server.simulateTransaction(tx));
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
    return scValToNative(sim.result!.retval);
  } catch (e) {
    console.warn("simulate() failed:", e);
    return null;
  }
}

// ── BLND price from CoinGecko ─────────────────────────────────────────────────

let _blndPriceCache: number | null = null;

/**
 * Fetch BLND price. Goes straight to CoinGecko since no pool oracle lists BLND.
 * The pool parameter is accepted for API consistency but currently unused.
 */
export async function fetchBlndPrice(pool: PoolDef, userAddress: string): Promise<number> {
  if (_blndPriceCache !== null) return _blndPriceCache;

  // CoinGecko free API
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=blend&vs_currencies=usd",
      { signal: AbortSignal.timeout(6000) },
    );
    if (res.ok) {
      const data = await res.json() as any;
      _blndPriceCache = data["blend"]?.usd ?? 0;
      console.log("[blend] BLND price from CoinGecko:", _blndPriceCache);
      return _blndPriceCache!;
    }
  } catch { /* fall through */ }

  _blndPriceCache = 0;
  console.warn("[blend] BLND price unavailable — emissions APR will show 0");
  return 0;
}

// ── Per-asset pool data ───────────────────────────────────────────────────────

export interface RateConfig {
  rBase:      number;  // 1e7 fixed-point
  rOne:       number;
  rTwo:       number;
  rThree:     number;
  utilOpt:    number;
  irMod:      number;
  backstopFP: number;
}

export interface ReserveStats {
  asset:         AssetInfo;
  cFactor:       number;
  lFactor:       number;   // liability factor (0..1); effective_debt = debt / lFactor
  priceUsd:      number;   // oracle price per 1 full token
  totalSupply:   number;   // full tokens
  totalBorrow:   number;
  available:     number;   // available to borrow
  bRate:         bigint;
  dRate:         bigint;
  bSupply:       bigint;   // raw b-token shares outstanding
  dSupply:       bigint;   // raw d-token shares outstanding
  interestBorrowApr: number; // % pa — interest rate model
  interestSupplyApr: number; // % pa — after backstop take
  blndSupplyApr:     number; // % pa — BLND emissions on supply side
  blndBorrowApr:     number; // % pa — BLND emissions on borrow side (currently 0)
  netSupplyApr:      number; // interest + blnd
  netBorrowCost:     number; // interest - blnd (usually just interest)
  supplyEps:         bigint; // raw eps from pool, 0 if no emissions
  borrowEps:         bigint;
  supplyEmission:    any;    // raw get_reserve_emissions result for supply token
  borrowEmission:    any;    // raw get_reserve_emissions result for borrow token
  rateConfig:        RateConfig;
}

export async function fetchAllReserves(pool: PoolDef, userAddress: string): Promise<ReserveStats[]> {
  const poolContract = new Contract(pool.id);
  const hasOracle    = !!pool.oracleId;
  const oracle       = hasOracle ? new Contract(pool.oracleId) : null;
  const blndPrice    = await fetchBlndPrice(pool, userAddress);
  const assets       = getPoolAssets(pool);

  // Process assets sequentially to avoid bursting the RPC with too many concurrent requests
  const results: ReserveStats[] = [];
  for (const asset of assets) {
    let reserveRaw: any = null;
    let priceRaw: any   = null;
    let supplyEmissions: any = null;
    let borrowEmissions: any = null;
    try {
      const calls: Promise<any>[] = [
        simulate(poolContract.call("get_reserve", new Address(asset.id).toScVal())),
        oracle
          ? simulate(oracle.call("lastprice", assetScVal(asset.id)))
          : Promise.resolve(null),
        simulate(poolContract.call("get_reserve_emissions", nativeToScVal(asset.supplyTokenId, { type: "u32" }))),
        simulate(poolContract.call("get_reserve_emissions", nativeToScVal(asset.borrowTokenId, { type: "u32" }))),
      ];
      [reserveRaw, priceRaw, supplyEmissions, borrowEmissions] = await Promise.all(calls);
    } catch (e) {
      console.warn(`fetchAllReserves: error fetching ${asset.symbol}:`, e);
    }

      const fallback = _cfg.assetMetadata[asset.id]?.fallbackPrice ?? 0;
      const priceUsd = priceRaw ? Number(BigInt(priceRaw.price)) / pool.oracleDec : fallback;


      const bRate   = reserveRaw ? BigInt(reserveRaw.data.b_rate)   : RATE_DEC;
      const dRate   = reserveRaw ? BigInt(reserveRaw.data.d_rate)   : RATE_DEC;
      const bSupply = reserveRaw ? BigInt(reserveRaw.data.b_supply) : 0n;
      const dSupply = reserveRaw ? BigInt(reserveRaw.data.d_supply) : 0n;

      const totalSupply  = Number(bSupply * bRate / RATE_DEC) / SCALAR_F;
      const totalBorrow  = Number(dSupply * dRate / RATE_DEC) / SCALAR_F;
      const maxUtilActual = reserveRaw ? reserveRaw.config.max_util / SCALAR_F : asset.maxUtil;
      const available    = Math.max(0, totalSupply * maxUtilActual - totalBorrow);
      const cFactor      = reserveRaw ? reserveRaw.config.c_factor / SCALAR_F : asset.cFactor;
      const lFactor      = reserveRaw ? reserveRaw.config.l_factor / SCALAR_F : 1.0;

      // ── Blend v2 exact interest rate formula (from blend-sdk-js) ────────────
      const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;

      // Raw fixed-point config values (all in 1e7 scale)
      const rBase_fp   = reserveRaw?.config.r_base   ?? 300_000;
      const rOne_fp    = reserveRaw?.config.r_one    ?? 400_000;
      const rTwo_fp    = reserveRaw?.config.r_two    ?? 1_200_000;
      const rThree_fp  = reserveRaw?.config.r_three  ?? 50_000_000;
      const utilOpt_fp = reserveRaw?.config.util     ?? 5_000_000;
      // ir_mod may be returned as BigInt (i128) or number (u32)
      const irMod_fp   = reserveRaw ? Number(BigInt(reserveRaw.data.ir_mod)) : 1_000_000;

      const curUtil_fp = Math.round(util * SCALAR_F);
      const FIXED_95PCT = 9_500_000;
      const BACKSTOP_FP = pool.backstopFP;

      let baseRate_fp: number;
      if (curUtil_fp <= utilOpt_fp) {
        // Branch 1: below or at target utilisation
        baseRate_fp = rBase_fp + Math.ceil(rOne_fp * curUtil_fp / utilOpt_fp);
      } else if (curUtil_fp <= FIXED_95PCT) {
        // Branch 2: target < util ≤ 95%
        const slope = Math.ceil((curUtil_fp - utilOpt_fp) * SCALAR_F / (FIXED_95PCT - utilOpt_fp));
        baseRate_fp = rBase_fp + rOne_fp + Math.ceil(rTwo_fp * slope / SCALAR_F);
      } else {
        // Branch 3: util > 95% — steep r_three slope
        const slope = Math.ceil((curUtil_fp - FIXED_95PCT) * SCALAR_F / (SCALAR_F - FIXED_95PCT));
        baseRate_fp = rBase_fp + rOne_fp + rTwo_fp + Math.ceil(rThree_fp * slope / SCALAR_F);
      }

      // Apply ir_mod (reactive modifier; neutral = 1e7, reduced = <1e7)
      const curIr_fp = Math.ceil(baseRate_fp * irMod_fp / SCALAR_F);

      const interestBorrowApr = (curIr_fp / SCALAR_F) * 100;

      // Supply APR = borrow_ir × (1 - backstop) × util  (all in fixed-point)
      const supplyCapture_fp  = Math.floor((SCALAR_F - BACKSTOP_FP) * curUtil_fp / SCALAR_F);
      const interestSupplyApr = (Math.floor(curIr_fp * supplyCapture_fp / SCALAR_F) / SCALAR_F) * 100;

      // BLND emissions APR
      const supplyEps = supplyEmissions?.eps != null ? BigInt(supplyEmissions.eps) : 0n;
      const borrowEps = borrowEmissions?.eps != null ? BigInt(borrowEmissions.eps) : 0n;
      const totalSupplyUsd = totalSupply * priceUsd;

      // BLND/yr = eps × seconds_per_year / 1e7 / 1e7
      const supplyBlndYr = Number(supplyEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
      const borrowBlndYr = Number(borrowEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;

      const blndSupplyApr = totalSupplyUsd > 0
        ? (supplyBlndYr * blndPrice / totalSupplyUsd) * 100
        : 0;
      const totalBorrowUsd = totalBorrow * priceUsd;
      const blndBorrowApr  = totalBorrowUsd > 0
        ? (borrowBlndYr * blndPrice / totalBorrowUsd) * 100
        : 0;

      console.log(`[blend:${pool.name}] ${asset.symbol} util=${util.toFixed(4)} c=${cFactor.toFixed(4)} l=${lFactor.toFixed(4)} borrowApr=${interestBorrowApr.toFixed(4)}% supplyApr=${interestSupplyApr.toFixed(4)}% blndSupplyApr=${blndSupplyApr.toFixed(4)}% supplyEps=${supplyEps}`);

      results.push({
        asset: { ...asset, cFactor, maxUtil: maxUtilActual },
        cFactor,
        lFactor,
        priceUsd,
        totalSupply,
        totalBorrow,
        available,
        bRate,
        dRate,
        bSupply,
        dSupply,
        interestBorrowApr,
        interestSupplyApr,
        blndSupplyApr,
        blndBorrowApr,
        netSupplyApr:  interestSupplyApr + blndSupplyApr,
        netBorrowCost: interestBorrowApr - blndBorrowApr,
        supplyEps,
        borrowEps,
        supplyEmission: supplyEmissions,
        borrowEmission: borrowEmissions,
        rateConfig: {
          rBase: rBase_fp, rOne: rOne_fp, rTwo: rTwo_fp, rThree: rThree_fp,
          utilOpt: utilOpt_fp, irMod: irMod_fp, backstopFP: BACKSTOP_FP,
        },
      });
  }
  return results;
}

// ── Projected rates (for preview with position impact) ───────────────────────

export interface ProjectedRates {
  interestSupplyApr: number;
  interestBorrowApr: number;
  blndSupplyApr:     number;
  blndBorrowApr:     number;
  netSupplyApr:      number;
  netBorrowCost:     number;
}

/**
 * Re-run the Blend rate model with projected pool totals to estimate how
 * a user's deposit will impact rates.
 *
 * @param rs       Current reserve stats (contains pool state + rate config)
 * @param addSupply Additional tokens supplied (user's deposit × leverage)
 * @param addBorrow Additional tokens borrowed (user's deposit × (leverage − 1))
 */
export function projectRates(rs: ReserveStats, addSupply: number, addBorrow: number): ProjectedRates {
  const { rBase, rOne, rTwo, rThree, utilOpt, irMod, backstopFP } = rs.rateConfig;
  const FIXED_95PCT = 9_500_000;

  const projSupply = rs.totalSupply + addSupply;
  const projBorrow = rs.totalBorrow + addBorrow;
  const projUtil   = projSupply > 0 ? projBorrow / projSupply : 0;
  const utilFp     = Math.round(projUtil * SCALAR_F);

  // 3-kink interest rate model
  let baseRate: number;
  if (utilFp <= utilOpt) {
    baseRate = rBase + Math.ceil(rOne * utilFp / utilOpt);
  } else if (utilFp <= FIXED_95PCT) {
    const slope = Math.ceil((utilFp - utilOpt) * SCALAR_F / (FIXED_95PCT - utilOpt));
    baseRate = rBase + rOne + Math.ceil(rTwo * slope / SCALAR_F);
  } else {
    const slope = Math.ceil((utilFp - FIXED_95PCT) * SCALAR_F / (SCALAR_F - FIXED_95PCT));
    baseRate = rBase + rOne + rTwo + Math.ceil(rThree * slope / SCALAR_F);
  }

  const curIr = Math.ceil(baseRate * irMod / SCALAR_F);
  const interestBorrowApr = (curIr / SCALAR_F) * 100;

  const supplyCapture = Math.floor((SCALAR_F - backstopFP) * utilFp / SCALAR_F);
  const interestSupplyApr = (Math.floor(curIr * supplyCapture / SCALAR_F) / SCALAR_F) * 100;

  // BLND emissions — same tokens/sec, diluted across new totals
  const supplyBlndYr = Number(rs.supplyEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
  const borrowBlndYr = Number(rs.borrowEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;

  const projSupplyUsd = projSupply * rs.priceUsd;
  const projBorrowUsd = projBorrow * rs.priceUsd;

  const bp = _blndPriceCache ?? 0;
  const blndSupplyApr = projSupplyUsd > 0 ? (supplyBlndYr * bp / projSupplyUsd) * 100 : 0;
  const blndBorrowApr = projBorrowUsd > 0 ? (borrowBlndYr * bp / projBorrowUsd) * 100 : 0;

  return {
    interestSupplyApr,
    interestBorrowApr,
    blndSupplyApr,
    blndBorrowApr,
    netSupplyApr:  interestSupplyApr + blndSupplyApr,
    netBorrowCost: interestBorrowApr - blndBorrowApr,
  };
}

// ── User position ─────────────────────────────────────────────────────────────

export interface AssetPosition {
  asset:        AssetInfo;
  bTokens:      bigint;
  dTokens:      bigint;
  bRate:        bigint;   // supply share → underlying exchange rate (RATE_DEC scale)
  dRate:        bigint;   // debt share → underlying exchange rate (RATE_DEC scale)
  collateral:   number;   // full tokens
  debt:         number;
  equity:       number;
  leverage:     number;
  hf:           number;
}

export interface UserPositions {
  byAsset: Map<string, AssetPosition>; // keyed by asset.id
}

export async function fetchUserPositions(
  pool: PoolDef,
  userAddress: string,
  reserves: ReserveStats[],
): Promise<UserPositions> {
  const poolContract = new Contract(pool.id);
  const raw  = await simulate(
    poolContract.call("get_positions", new Address(userAddress).toScVal())
  );

  const byAsset = new Map<string, AssetPosition>();
  for (const rs of reserves) {
    const bTokens = BigInt(raw?.collateral?.[rs.asset.reserveIndex] ?? 0);
    const dTokens = BigInt(raw?.liabilities?.[rs.asset.reserveIndex] ?? 0);
    if (bTokens === 0n && dTokens === 0n) continue;

    const collateral = Number(bTokens * rs.bRate / RATE_DEC) / SCALAR_F;
    const debt       = Number(dTokens * rs.dRate / RATE_DEC) / SCALAR_F;
    const equity     = collateral - debt;
    const leverage   = equity > 0 ? collateral / equity : 0;
    const hf         = debt > 0 ? (collateral * rs.cFactor) / (debt / rs.lFactor) : Infinity;

    byAsset.set(rs.asset.id, {
      asset: rs.asset,
      bTokens,
      dTokens,
      bRate: rs.bRate,
      dRate: rs.dRate,
      collateral,
      debt,
      equity,
      leverage,
      hf,
    });
  }
  return { byAsset };
}

export async function fetchAssetBalance(userAddress: string, assetId: string): Promise<number> {
  const token = new Contract(assetId);
  const raw   = await simulate(
    token.call("balance", new Address(userAddress).toScVal())
  );
  if (raw === null) return 0;
  const stroops = typeof raw === "bigint" ? raw : BigInt(raw as any);
  return Number(stroops) / SCALAR_F;
}


// ── Leverage math ─────────────────────────────────────────────────────────────

/** Health factor at a given leverage, collateral factor, and liability factor. */
export function hfForLeverage(lev: number, c: number, l: number = 1): number {
  return lev <= 1 ? Infinity : (c * lev) / ((lev - 1) / l);
}

/** Maximum leverage where HF ≥ given minimum. */
export function maxLeverageFor(c: number, l: number = 1, minHF: number = 1.01): number {
  // HF = c * lev / ((lev - 1) / l) = c * l * lev / (lev - 1)
  // Solve HF = minHF: lev = minHF / (minHF - c * l)
  const cl = c * l;
  return cl >= minHF ? 100 : minHF / (minHF - cl);
}

// ── Safety guards ────────────────────────────────────────────────────────────
//
// These mitigate the structural risks of leveraged loop positions:
//
// 1. Circular Collateral / Liquidity Lock (Critical):
//    Collateral and debt are claims on the SAME pool. At high utilization,
//    d-tokens cannot be redeemed → liquidators can't profit → bad debt.
//
// 2. Rate Manipulation Forced Liquidation (High):
//    An attacker can spike utilization to force borrow APR up, eroding HF
//    of existing positions and profiting from liquidations.
//
// 3. Cascade Liquidation (Medium):
//    One large liquidation shifts utilization enough to push adjacent
//    positions below HF=1.0, triggering a chain reaction.
//
// Guards below refuse to open/extend positions when conditions are unsafe.

/** Maximum pool utilization at which new leveraged positions are allowed. */
export const MAX_SAFE_UTILIZATION = 0.85;

/** Maximum allowed borrow-supply APR spread (percentage points). */
export const MAX_RATE_SPREAD_PCT = 15;

/** Minimum post-loop pool liquidity ratio (available / totalSupply). */
export const MIN_POST_LOOP_LIQUIDITY = 0.10;

export interface LoopSafetyResult {
  safe:     boolean;
  warnings: string[];
  errors:   string[];
  utilization:       number;  // current pool utilization
  projectedUtil:     number;  // utilization after opening the loop
  rateSpreadPct:     number;  // borrowAPR - supplyAPR (percentage points)
  postLoopLiquidity: number;  // available / totalSupply after deposit
}

/**
 * Pre-flight safety check for opening a leveraged loop position.
 *
 * Validates:
 *  1. Utilization cap — refuses if pool utilization > MAX_SAFE_UTILIZATION
 *  2. Projected utilization — refuses if the loop itself would push utilization above cap
 *  3. Rate spread guard — warns if borrow-supply spread is dangerously high
 *  4. Liquidation incentive — warns if post-loop liquidity is too low for liquidators
 */
export function checkLoopSafety(
  rs: ReserveStats,
  initialAmount: number,
  leverage: number,
): LoopSafetyResult {
  const warnings: string[] = [];
  const errors: string[]   = [];

  // Current utilization
  const utilization = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;

  // Projected pool state after the loop
  const totalSupplyPost = rs.totalSupply + initialAmount * leverage;
  const totalBorrowPost = rs.totalBorrow + initialAmount * (leverage - 1);
  const projectedUtil   = totalSupplyPost > 0 ? totalBorrowPost / totalSupplyPost : 0;

  // Post-loop available liquidity (for liquidator d-token redemption)
  const maxUtilPost      = rs.asset.maxUtil;
  const availablePost    = Math.max(0, totalSupplyPost * maxUtilPost - totalBorrowPost);
  const postLoopLiquidity = totalSupplyPost > 0 ? availablePost / totalSupplyPost : 0;

  // Rate spread
  const rateSpreadPct = rs.interestBorrowApr - rs.interestSupplyApr;

  // ── Check 1: Current utilization cap ──
  if (utilization > MAX_SAFE_UTILIZATION) {
    errors.push(
      `Pool utilization is ${(utilization * 100).toFixed(1)}% (max ${(MAX_SAFE_UTILIZATION * 100).toFixed(0)}%). ` +
      `High utilization means d-tokens (collateral) cannot be redeemed — liquidators won't act, risking bad debt.`
    );
  }

  // ── Check 2: Projected utilization after loop ──
  if (projectedUtil > MAX_SAFE_UTILIZATION) {
    errors.push(
      `This position would push pool utilization to ${(projectedUtil * 100).toFixed(1)}% ` +
      `(max ${(MAX_SAFE_UTILIZATION * 100).toFixed(0)}%). Reduce leverage or deposit amount.`
    );
  }

  // ── Check 3: Rate spread guard ──
  if (rateSpreadPct > MAX_RATE_SPREAD_PCT) {
    errors.push(
      `Borrow-supply spread is ${rateSpreadPct.toFixed(1)}% — abnormally high. ` +
      `This may indicate rate manipulation. Wait for rates to stabilize.`
    );
  } else if (rateSpreadPct > 5) {
    warnings.push(
      `Borrow-supply spread is ${rateSpreadPct.toFixed(1)}%/yr — HF will erode quickly.`
    );
  }

  // ── Check 4: Liquidation incentive (post-loop liquidity) ──
  if (postLoopLiquidity < MIN_POST_LOOP_LIQUIDITY) {
    warnings.push(
      `Post-loop pool liquidity would be only ${(postLoopLiquidity * 100).toFixed(1)}%. ` +
      `If HF drops, liquidators may not be able to redeem collateral d-tokens.`
    );
  }

  return {
    safe: errors.length === 0,
    warnings,
    errors,
    utilization,
    projectedUtil,
    rateSpreadPct,
    postLoopLiquidity,
  };
}

// ── Pool comparison data ──────────────────────────────────────────────────────

export interface CompareRow {
  pool:       PoolDef;
  asset:      AssetInfo;
  supplyApy:  number;   // % — net supply APY (interest + BLND)
  borrowApy:  number;   // % — net borrow APY (interest - BLND)
  netApy5x:   number;   // % — net APY at 5× leverage
  netApy10x:  number;   // % — net APY at 10× leverage
  cFactor:    number;   // 0..1
  tvl:        number;   // USD
  utilization: number;  // 0..1
}

/**
 * Fetch reserve stats for all mainnet pools and return a flat list of
 * CompareRow entries — one per (pool, asset) pair.
 * No wallet connection required.
 */
export async function fetchCompareData(): Promise<CompareRow[]> {
  const rows: CompareRow[] = [];
  const pools = getKnownPools();

  await Promise.all(pools.map(async (pool) => {
    try {
      const reserves = await fetchAllReserves(pool, "");
      for (const rs of reserves) {
        const supplyApy = (Math.exp(rs.netSupplyApr / 100) - 1) * 100;
        const borrowApy = (Math.exp(rs.netBorrowCost / 100) - 1) * 100;
        const netApy5x  = (Math.exp((rs.netSupplyApr * 5 - rs.netBorrowCost * 4) / 100) - 1) * 100;
        const netApy10x = (Math.exp((rs.netSupplyApr * 10 - rs.netBorrowCost * 9) / 100) - 1) * 100;
        const tvl = rs.totalSupply * rs.priceUsd;
        const utilization = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
        rows.push({
          pool,
          asset: rs.asset,
          supplyApy,
          borrowApy,
          netApy5x,
          netApy10x,
          cFactor: rs.cFactor,
          tvl,
          utilization,
        });
      }
    } catch (e) {
      console.warn(`fetchCompareData: failed for pool ${pool.name}:`, e);
    }
  }));

  return rows;
}

/**
 * Build supply/borrow request sequence to reach a target leverage.
 * Each loop supplies current balance as collateral, then borrows the minimum of
 * (balance × cFactor) and (remaining borrow needed). The final step supplies
 * whatever is left. This achieves exactly targetLev × initial total collateral.
 */
function buildOpenRequests(
  assetId: string,
  initialStroops: bigint,
  cFactorBn: bigint,    // cFactor × SCALAR e.g. 9_500_000 for 0.95
  targetLev: number,
): xdr.ScVal[] {
  const items: xdr.ScVal[] = [];
  const targetBorrow = BigInt(Math.round((targetLev - 1) * Number(initialStroops)));
  let balance      = initialStroops;
  let totalBorrowed = 0n;

  while (totalBorrowed < targetBorrow) {
    items.push(buildRequest(assetId, balance, SUPPLY_COLLATERAL));
    const maxCanBorrow = balance * cFactorBn / SCALAR;
    const stillNeeded  = targetBorrow - totalBorrowed;
    const borrow       = maxCanBorrow < stillNeeded ? maxCanBorrow : stillNeeded;
    if (borrow <= 0n) break;
    items.push(buildRequest(assetId, borrow, BORROW));
    totalBorrowed += borrow;
    balance = borrow;
  }
  items.push(buildRequest(assetId, balance, SUPPLY_COLLATERAL));
  return items;
}

// ── Transaction builders ──────────────────────────────────────────────────────

export async function buildApproveXdr(
  pool: PoolDef,
  userAddress: string,
  assetId: string,
  amountStroops: bigint,
): Promise<string> {
  const token     = new Contract(assetId);
  const addrScVal = new Address(userAddress).toScVal();
  const poolScVal = new Address(pool.id).toScVal();
  const ledger    = await server.getLatestLedger();
  const expiry    = ledger.sequence + 120;

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(token.call(
      "approve",
      addrScVal,
      poolScVal,
      i128ToScVal(amountStroops),
      nativeToScVal(expiry, { type: "u32" }),
    ))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Approve simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

export async function buildOpenPositionXdr(
  pool: PoolDef,
  userAddress: string,
  asset: AssetInfo,
  initialStroops: bigint,
  leverage: number,
): Promise<string> {
  const cFactorBn    = BigInt(Math.round(asset.cFactor * SCALAR_F));
  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const requests     = buildRequestsVec(buildOpenRequests(asset.id, initialStroops, cFactorBn, leverage));

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Open position simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/**
 * Build a REPAY + WITHDRAW transaction to fully close a leveraged position.
 *
 * REPAY comes first to clear the debt — withdrawing collateral while debt
 * exists triggers #1224 (MinCollateralNotMet).
 *
 * Uses submit_with_allowance which NETS transfers: for close, the net is
 * collateral − debt = equity, so the pool just sends equity to the user.
 * No approve step needed (net flow is pool → user, not user → pool).
 *
 * REPAY uses exact underlying amount (no buffer) to avoid #1219
 * (InvalidDTokenBurnAmount). Blend caps WITHDRAW at actual b-tokens,
 * so any tiny residual collateral from rate ticks is safe.
 */
export async function buildCloseSubmitXdr(
  pool: PoolDef,
  userAddress: string,
  pos: AssetPosition,
): Promise<string> {
  // Use i64::MAX for both amounts — Blend caps REPAY at actual d-tokens
  // and WITHDRAW at actual b-tokens. Passing exact computed amounts is
  // fragile because rates tick between fetch and execution, causing the
  // amount to overshoot and trigger #1219 (InvalidDTokenBurnAmount).
  const MAX_AMOUNT = 9_223_372_036_854_775_807n; // i64::MAX
  const reqItems: xdr.ScVal[] = [];
  if (pos.dTokens > 0n) {
    reqItems.push(buildRequest(pos.asset.id, MAX_AMOUNT, REPAY));
  }
  reqItems.push(buildRequest(pos.asset.id, MAX_AMOUNT, WITHDRAW_COLLATERAL));
  const requests = buildRequestsVec(reqItems);

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx           = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Close simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/**
 * Repay all outstanding debt without fully closing the position.
 * Withdraws exactly the debt amount from collateral and repays it — all in
 * one atomic submit_with_allowance call. Blend's netting means the net token
 * flow is ≈0, so no user wallet balance is needed and no approve step.
 * Result: same equity, zero debt, reduced collateral (user is de-leveraged).
 */
export async function buildRepayXdr(
  pool: PoolDef,
  userAddress: string,
  pos: AssetPosition,
): Promise<string> {
  // Use i64::MAX for REPAY — Blend caps at actual d-tokens, avoiding #1219.
  // WITHDRAW uses d-token-derived amount +1 to cover any rounding.
  const MAX_REPAY = 9_223_372_036_854_775_807n;
  const debtAmount = pos.dTokens * pos.dRate / RATE_DEC + 1n;
  const requests   = buildRequestsVec([
    buildRequest(pos.asset.id, debtAmount, WITHDRAW_COLLATERAL),
    buildRequest(pos.asset.id, MAX_REPAY,  REPAY),
  ]);

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx           = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Repay simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/**
 * Build a standalone WITHDRAW_COLLATERAL transaction (no debt repay).
 * Used after deleveraging to pull remaining equity out of the pool.
 * Uses i64::MAX — Blend caps at actual b-tokens.
 */
export async function buildWithdrawXdr(
  pool: PoolDef,
  userAddress: string,
  assetId: string,
): Promise<string> {
  const MAX_AMOUNT = 9_223_372_036_854_775_807n;
  const requests = buildRequestsVec([
    buildRequest(assetId, MAX_AMOUNT, WITHDRAW_COLLATERAL),
  ]);

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx           = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Withdraw simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/**
 * Returns total pending BLND (in full BLND, 7 decimals) across ALL user
 * positions in the pool by simulating the claim call. This gives the exact
 * on-chain amount — no manual index math needed.
 */
export async function fetchPoolPendingBlnd(
  pool: PoolDef,
  userAddress: string,
  positions: UserPositions,
): Promise<number> {
  // Collect all token IDs where user has positions
  const tokenIds: number[] = [];
  for (const pos of positions.byAsset.values()) {
    if (pos.bTokens > 0n) tokenIds.push(pos.asset.supplyTokenId);
    if (pos.dTokens > 0n) tokenIds.push(pos.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) return 0;

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const tokenIdsScVal = xdr.ScVal.scvVec(
    tokenIds.map(id => nativeToScVal(id, { type: "u32" }))
  );
  const result = await simulate(
    poolContract.call("claim", addrScVal, tokenIdsScVal, addrScVal)
  );
  if (result === null) return 0;
  const stroops = typeof result === "bigint" ? result : BigInt(result as any);
  return Number(stroops > 0n ? stroops : 0n) / SCALAR_F;
}

export async function buildClaimXdr(
  pool: PoolDef,
  userAddress: string,
  tokenIds: number[],
): Promise<string> {
  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const tokenIds_scv = xdr.ScVal.scvVec(
    tokenIds.map(id => nativeToScVal(id, { type: "u32" }))
  );

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("claim", addrScVal, tokenIds_scv, addrScVal))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Claim simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

// ── Adjust leverage (increase / decrease) ────────────────────────────────

/**
 * Build requests to INCREASE leverage on an existing position.
 * Borrows more and supplies as collateral in a loop, same pattern as opening.
 * No wallet tokens needed — all new collateral comes from borrowing.
 */
export async function buildIncreaseLeverageXdr(
  pool: PoolDef,
  userAddress: string,
  asset: AssetInfo,
  pos: AssetPosition,
  targetLev: number,
): Promise<string> {
  if (pos.equity <= 0) throw new Error("No equity in position");
  const targetCollateral = pos.equity * targetLev;
  const additionalBorrow = targetCollateral - pos.collateral;
  if (additionalBorrow <= 0) throw new Error("Target leverage is not higher than current");

  const additionalBorrowStroops = BigInt(Math.round(additionalBorrow * 1e7));
  const cFactorBn = BigInt(Math.round(asset.cFactor * SCALAR_F));

  // Build BORROW → SUPPLY loop for the additional amount
  const items: xdr.ScVal[] = [];
  let totalBorrowed = 0n;
  let balance = 0n;

  // First borrow: use existing unused borrowing capacity
  const firstBorrow = additionalBorrowStroops < (pos.collateral * 1e7 > 0 ? BigInt(Math.round(pos.collateral * 1e7)) * cFactorBn / SCALAR - BigInt(Math.round(pos.debt * 1e7)) : 0n)
    ? additionalBorrowStroops
    : additionalBorrowStroops;

  // Simple loop: borrow chunk, supply it, borrow more against new collateral
  let remaining = additionalBorrowStroops;
  while (remaining > 0n) {
    // How much can we borrow? Based on what we just supplied
    const canBorrow = balance > 0n ? balance * cFactorBn / SCALAR : remaining;
    const borrow = canBorrow < remaining ? canBorrow : remaining;
    if (borrow <= 0n) break;
    items.push(buildRequest(asset.id, borrow, BORROW));
    totalBorrowed += borrow;
    remaining -= borrow;
    // Supply what we just borrowed
    items.push(buildRequest(asset.id, borrow, SUPPLY_COLLATERAL));
    balance = borrow;
  }

  const requests = buildRequestsVec(items);
  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Increase leverage simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

/**
 * Build requests to DECREASE leverage on an existing position.
 * Withdraws collateral and repays debt. Net flow ≈ 0 (equity stays same).
 * Uses submit_with_allowance netting — no wallet balance needed.
 */
export async function buildDecreaseLeverageXdr(
  pool: PoolDef,
  userAddress: string,
  asset: AssetInfo,
  pos: AssetPosition,
  targetLev: number,
): Promise<string> {
  if (pos.equity <= 0) throw new Error("No equity in position");
  const targetDebt = pos.equity * (targetLev - 1);
  const debtReduction = pos.debt - targetDebt;
  if (debtReduction <= 0) throw new Error("Target leverage is not lower than current");

  const debtReductionStroops = BigInt(Math.round(debtReduction * 1e7));

  // WITHDRAW collateral equal to debt reduction, then REPAY
  // Netting means net flow ≈ 0
  const requests = buildRequestsVec([
    buildRequest(asset.id, debtReductionStroops, WITHDRAW_COLLATERAL),
    buildRequest(asset.id, debtReductionStroops, REPAY),
  ]);

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Decrease leverage simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

// ── Resupply (add collateral to existing position) ───────────────────────

/**
 * Build a SUPPLY_COLLATERAL transaction to add more collateral to an
 * existing position. This increases HF without changing debt.
 * Requires a prior approve for the amount.
 */
export async function buildResupplyXdr(
  pool: PoolDef,
  userAddress: string,
  assetId: string,
  amountStroops: bigint,
): Promise<string> {
  const requests = buildRequestsVec([
    buildRequest(assetId, amountStroops, SUPPLY_COLLATERAL),
  ]);

  const poolContract = new Contract(pool.id);
  const addrScVal    = new Address(userAddress).toScVal();
  const acc          = await server.getAccount(userAddress);
  const tx           = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(poolContract.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Resupply simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

// ── Swap BLND → asset via Stellar DEX path payment ───────────────────────

/**
 * Build a path_payment_strict_send to swap BLND → target asset using Horizon
 * path finding. Returns the XDR ready for signing.
 *
 * @param blndAmount - full BLND tokens (e.g. 12.345)
 * @param destAssetId - Soroban contract ID of the target asset
 * @param minDestAmount - minimum acceptable output (after slippage)
 */
export async function buildSwapBlndXdr(
  userAddress: string,
  blndAmount: number,
  destAssetId: string,
  slippage: number = 0.02,
): Promise<{ xdr: string; estimate: string }> {
  const destAsset = _cfg.classicAssets[destAssetId];
  if (!destAsset) throw new Error(`No classic asset mapping for ${destAssetId}`);

  const sendAmount = blndAmount.toFixed(7);

  // Find best path via Horizon
  const paths = await horizon
    .strictSendPaths(_cfg.blndClassic, sendAmount, [destAsset])
    .call();

  if (paths.records.length === 0)
    throw new Error("No swap path found for BLND → " + (destAsset.isNative() ? "XLM" : destAsset.getCode()));

  // Pick the best path (first record = highest destination amount)
  const best = paths.records[0];
  const estimatedDest = best.destination_amount;
  const minDest = (parseFloat(estimatedDest) * (1 - slippage)).toFixed(7);

  // Build intermediate path assets
  const pathAssets = best.path.map((p: any) =>
    p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
  );

  const acc = await horizon.loadAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: "10000",
    networkPassphrase: _cfg.passphrase,
  })
    .addOperation(Operation.pathPaymentStrictSend({
      sendAsset:   _cfg.blndClassic,
      sendAmount:  sendAmount,
      destination: userAddress,
      destAsset:   destAsset,
      destMin:     minDest,
      path:        pathAssets,
    }))
    .setTimeout(60)
    .build();

  return { xdr: tx.toXDR(), estimate: estimatedDest };
}

/**
 * Check if a swap path exists for BLND → target asset and return estimated output.
 */
export async function estimateBlndSwap(
  blndAmount: number,
  destAssetId: string,
): Promise<{ estimate: number; path: string } | null> {
  const destAsset = _cfg.classicAssets[destAssetId];
  if (!destAsset) return null;

  try {
    const paths = await horizon
      .strictSendPaths(_cfg.blndClassic, blndAmount.toFixed(7), [destAsset])
      .call();
    if (paths.records.length === 0) return null;
    const best = paths.records[0];
    const via = best.path.map((p: any) => p.asset_type === "native" ? "XLM" : p.asset_code).join(" → ");
    return {
      estimate: parseFloat(best.destination_amount),
      path: via ? `BLND → ${via} → ${destAsset.isNative() ? "XLM" : destAsset.getCode()}` : `BLND → ${destAsset.isNative() ? "XLM" : destAsset.getCode()}`,
    };
  } catch {
    return null;
  }
}

// ── Submit signed XDR ─────────────────────────────────────────────────────────

export async function submitSignedXdr(signedXdr: string): Promise<string> {
  const tx     = TransactionBuilder.fromXDR(signedXdr, _cfg.passphrase);
  const result = await withRetry(() => server.sendTransaction(tx));
  if (result.status === "ERROR")
    throw new Error(`Send failed: ${result.errorResult?.toXDR("base64")}`);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await withRetry(() => server.getTransaction(result.hash));
    if (poll.status === "SUCCESS") return result.hash;
    if (poll.status === "FAILED")
      throw new Error(`On-chain failure: ${poll.resultXdr?.toXDR("base64")}`);
  }
  throw new Error("Confirmation timed out");
}

/** Submit a classic (non-Soroban) transaction via Horizon. */
export async function submitClassicXdr(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, _cfg.passphrase);
  const result = await horizon.submitTransaction(tx);
  return (result as any).hash;
}
