/**
 * Turbolong UI — multi-pool support (Etherfuse, Fixed, YieldBlox)
 */

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule }   from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule }       from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule }      from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule }      from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule }        from "@creit-tech/stellar-wallets-kit/modules/hana";
import { Networks }          from "@creit-tech/stellar-wallets-kit/types";
import { estimateSwap }      from "@stellar-broker/client";
import {
  Asset,
  Horizon,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import {
  getKnownPools,
  getPoolAssets,
  getNetworkPassphrase,
  getActiveNetwork,
  getHorizonUrl,
  getBlndId,
  setNetwork,
  fetchAllReserves,
  fetchUserPositions,
  fetchAssetBalance,
  fetchPoolPendingBlnd,
  buildApproveXdr,
  buildOpenPositionXdr,
  buildCloseSubmitXdr,
  buildRepayXdr,
  buildWithdrawXdr,
  buildClaimXdr,
  buildIncreaseLeverageXdr,
  buildDecreaseLeverageXdr,
  buildResupplyXdr,
  buildSwapBlndXdr,
  estimateBlndSwap,
  submitSignedXdr,
  submitClassicXdr,
  hfForLeverage,
  maxLeverageFor,
  fetchCompareData,
  type NetworkMode,
  type AssetInfo,
  type PoolDef,
  type ReserveStats,
  type AssetPosition,
  type UserPositions,
  type CompareRow,
  projectRates,
} from "./blend.ts";

import {
  getVaults,
  fetchVaultStats,
  fetchUserVaultBalance,
  buildVaultDepositXdr,
  buildVaultWithdrawXdr,
  buildVaultRebalanceXdr,
  fetchTokenBalance,
  formatUsd,
  formatHf,
  type VaultConfig,
  type VaultStats,
  type UserVaultPosition,
} from "./defindex.ts";

// ── Wallet kit ────────────────────────────────────────────────────────────────

StellarWalletsKit.init({
  modules: [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule(),
    new HanaModule(),
  ],
  network: Networks.PUBLIC,
});

// ── State ─────────────────────────────────────────────────────────────────────

let userAddress: string | null = null;
let reserves:    ReserveStats[]  = [];
let positions:   UserPositions   = { byAsset: new Map() };
let selectedPool: PoolDef        = getKnownPools()[0]; // default: Etherfuse
let assets: AssetInfo[]          = getPoolAssets(selectedPool);
let selectedAsset: AssetInfo     = assets[2]; // default: CETES (index 2 in Etherfuse)

// ── Network switching ────────────────────────────────────────────────────────

async function switchNetwork(net: NetworkMode) {
  // Disconnect wallet first
  if (userAddress && !demoMode) {
    await StellarWalletsKit.disconnect();
  }
  userAddress = null;
  localStorage.removeItem("walletAddress");

  // Switch blend.ts network config
  setNetwork(net);
  localStorage.setItem("networkMode", net);

  // Reinitialize wallet kit for new network
  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new LobstrModule(),
      new HanaModule(),
    ],
    network: net === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
  });

  // Reset state
  reserves = [];
  positions = { byAsset: new Map() };
  demoMode = false;
  selectedPool = getKnownPools()[0];
  assets = getPoolAssets(selectedPool);
  selectedAsset = assets[0];

  // Update UI
  const btn = $("network-toggle");
  btn.textContent = net === "testnet" ? "Testnet" : "Mainnet";
  btn.classList.toggle("testnet-active", net === "testnet");
  $("testnet-banner").classList.toggle("hidden", net !== "testnet");
  ($("fund-testnet-btn") as HTMLButtonElement).disabled = false;
  ($("fund-testnet-btn") as HTMLButtonElement).textContent = "Fund Wallet";

  // Reset vault state
  _lastVaultStats = null;
  _userVaultBalance = 0;
  _userWalletBalance = 0;
  $("vault-tvl").textContent = "--";
  $("vault-share-price").textContent = "--";
  $("vault-apy").textContent = "--";
  $("vault-leverage").textContent = "--";
  $("vault-hf").textContent = "--";
  $("vault-min-hf").textContent = "--";
  $("vault-strategy-pos").classList.add("hidden");
  $("vault-hf-bar-wrap").classList.add("hidden");
  $("vault-user-pos").classList.add("hidden");
  $("vault-wallet-balance").textContent = "--";
  $("vault-withdraw-balance").textContent = "--";

  // Reset view
  $("connect-btn").classList.remove("hidden");
  $("wallet-connected").classList.add("hidden");
  $("connect-prompt").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
  $("overview-view").classList.add("hidden");
  $("asset-tabs-bar").style.display = "none";
  switchView("leverage");
  buildPoolTabs();
  buildAssetTabs();
  renderPoolFooter();
  updatePreview();

  // Prompt user to switch wallet network
  const label = net === "testnet" ? "Testnet" : "Mainnet (Public)";
  toast(`Switched to ${label}. Please also switch your wallet to ${label} before connecting.`, "info");
}

/** Check that the connected wallet's network matches the app's selected network. */
async function verifyWalletNetwork(): Promise<boolean> {
  try {
    const walletNet = await StellarWalletsKit.getNetwork();
    const expectedPassphrase = getNetworkPassphrase();
    if (walletNet.networkPassphrase !== expectedPassphrase) {
      const expected = getActiveNetwork() === "testnet" ? "Testnet" : "Mainnet";
      toast(`Network mismatch: your wallet is on a different network. Please switch your wallet to ${expected}.`, "error");
      return false;
    }
    return true;
  } catch {
    // If getNetwork isn't supported (e.g. some wallets), skip the check
    return true;
  }
}

// ── Fund testnet wallet ──────────────────────────────────────────────────────

const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

async function fundTestnetWallet() {
  if (!userAddress || getActiveNetwork() !== "testnet") return;
  const btn = $("fund-testnet-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Funding...";

  try {
    // Step 1: Friendbot — fund with 10,000 XLM
    toast("Requesting testnet XLM from Friendbot...", "info");
    const fbRes = await fetch(`https://friendbot.stellar.org?addr=${userAddress}`);
    if (!fbRes.ok) {
      // Any friendbot failure is non-fatal — account likely already exists
      toast("Account already exists on testnet, skipping Friendbot", "info");
    } else {
      toast("Received testnet XLM from Friendbot!", "success");
    }

    // Step 2: Open USDC trustline + swap XLM → USDC via path payment
    toast("Opening USDC trustline and acquiring USDC...", "info");
    const usdcAsset = new Asset("USDC", TESTNET_USDC_ISSUER);

    const horizonServer = new Horizon.Server(getHorizonUrl());
    const acc = await horizonServer.loadAccount(userAddress);

    // Check if trustline already exists
    const hasTrustline = acc.balances.some(
      (b: any) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER
    );

    const txBuilder = new TransactionBuilder(acc, {
      fee: "10000",
      networkPassphrase: getNetworkPassphrase(),
    }).setTimeout(60);

    if (!hasTrustline) {
      txBuilder.addOperation(Operation.changeTrust({ asset: usdcAsset, limit: "1000000" }));
    }

    // Path payment: swap 1000 XLM → USDC (strict send, accept any amount)
    txBuilder.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: "1000",
        destination: userAddress,
        destAsset: usdcAsset,
        destMin: "0.0000001", // accept any amount
        path: [],
      })
    );

    const tx = txBuilder.build();

    // Sign via wallet kit
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), {
      networkPassphrase: getNetworkPassphrase(),
      address: userAddress,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, getNetworkPassphrase());
    const result = await horizonServer.submitTransaction(signedTx);
    if (!(result as any).successful) {
      throw new Error("Transaction failed");
    }

    toast("Testnet wallet funded! USDC trustline opened and tokens acquired.", "success");
    // Reload current view data
    if (activeView === "leverage") await loadAll();
    else if (activeView === "vault") await refreshVaultView();
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // If path payment fails (no liquidity), still report trustline success
    if (msg.includes("PATH_PAYMENT") || msg.includes("path")) {
      toast("USDC trustline opened but no DEX liquidity to swap. You may need to acquire USDC manually.", "info");
    } else {
      toast(`Fund failed: ${msg.slice(0, 150)}`, "error");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Fund Wallet";
  }
}

// ── Theme ────────────────────────────────────────────────────────────────────

type Theme = "light" | "dark";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // Update theme badge in settings dropdown
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const badge = btn.querySelector(".settings-badge");
    if (badge) badge.innerHTML = theme === "dark" ? "&#9790;" : "&#9728;";
  }
  // Also update mobile theme toggle
  const mobileBtn = document.getElementById("mobile-theme-toggle");
  if (mobileBtn) mobileBtn.innerHTML = theme === "dark" ? "&#9790;" : "&#9728;";
}

// Initialize: check localStorage override, else follow system
const savedTheme = localStorage.getItem("theme") as Theme | null;
applyTheme(savedTheme ?? getSystemTheme());

// Listen for system changes (only when no manual override)
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!localStorage.getItem("theme")) applyTheme(getSystemTheme());
});

// ── Disclaimer ───────────────────────────────────────────────────────────

if (!localStorage.getItem("disclaimerAccepted")) {
  document.getElementById("disclaimer-overlay")!.classList.remove("hidden");
}
document.getElementById("disclaimer-checkbox")!.addEventListener("change", (e) => {
  (document.getElementById("disclaimer-accept") as HTMLButtonElement).disabled =
    !(e.target as HTMLInputElement).checked;
});
document.getElementById("disclaimer-accept")!.addEventListener("click", () => {
  localStorage.setItem("disclaimerAccepted", "1");
  document.getElementById("disclaimer-overlay")!.classList.add("hidden");
});

// ── Active view (leverage | swap) ────────────────────────────────────────

type AppView = "overview" | "leverage" | "swap" | "vault";
let activeView: AppView = "leverage";

// ── Expert mode ──────────────────────────────────────────────────────────────

let expertMode = false;
const MIN_HF_NORMAL = 1.01;
const MIN_HF_EXPERT = 1.00001;
function minHF() { return expertMode ? MIN_HF_EXPERT : MIN_HF_NORMAL; }

// ── Demo mode ────────────────────────────────────────────────────────────────

let demoMode = false;

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const fmt  = (n: number, d = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;
const fmtAddr = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);

// ── Skeleton loading (#3) ────────────────────────────────────────────────────

/** Skeleton widths that match the typical rendered width of each stat element. */
const SKELETON_WIDTHS: Record<string, string> = {
  "stat-cfactor":          "3em",
  "stat-max-lev":          "4em",
  "stat-liquidity":        "8em",
  "stat-util":             "3.5em",
  "stat-price":            "5em",
  "supply-interest-apr":   "4em",
  "supply-blnd-apr":       "4em",
  "supply-net-apr":        "4em",
  "borrow-interest-apr":   "4em",
  "borrow-blnd-apr":       "4em",
  "borrow-net-cost":       "4em",
  "pos-collateral":        "10em",
  "pos-debt":              "10em",
  "pos-equity":            "10em",
  "pos-leverage":          "3em",
  "pos-hf":                "4em",
  "pos-pool-hf":           "4em",
  "pos-net-apr":           "5em",
  "pos-headroom":          "5em",
  "pos-liq-days":          "7em",
};

function setSkeleton(id: string) {
  const el = $(id);
  el.textContent = "\u00A0";
  el.classList.add("skeleton");
  const w = SKELETON_WIDTHS[id];
  if (w) el.style.minWidth = w;
}
function clearSkeleton(id: string) {
  const el = $(id);
  el.classList.remove("skeleton");
  el.style.minWidth = "";
}

// ── Data freshness (#4) ─────────────────────────────────────────────────────

let lastRefreshTime = 0;
let freshnessInterval: ReturnType<typeof setInterval> | null = null;
let autoRefreshInterval: ReturnType<typeof setInterval> | null = null;

function updateFreshnessDisplay() {
  if (!lastRefreshTime) return;
  const secs = Math.round((Date.now() - lastRefreshTime) / 1000);
  const el = $("data-freshness");
  if (secs < 5) { el.textContent = "Just now"; }
  else if (secs < 60) { el.textContent = `${secs}s ago`; }
  else { el.textContent = `${Math.floor(secs / 60)}m ago`; }
  el.classList.toggle("stale", secs > 60);
}

function startFreshnessTimer() {
  lastRefreshTime = Date.now();
  if (freshnessInterval) clearInterval(freshnessInterval);
  freshnessInterval = setInterval(updateFreshnessDisplay, 5000);
  updateFreshnessDisplay();
  // Auto-refresh after 60s
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(() => { if (userAddress && !demoMode) loadAll(); }, 60_000);
}

// ── Animated number transitions (#11) ────────────────────────────────────────

function animateNumber(el: HTMLElement, to: number, duration = 200, formatFn: (n: number) => string = (n) => fmt(n, 2)) {
  const fromText = el.textContent?.replace(/[^\d.\-]/g, "") ?? "0";
  const from = parseFloat(fromText) || 0;
  if (Math.abs(from - to) < 0.001) { el.textContent = formatFn(to); return; }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = formatFn(to); return;
  }
  const start = performance.now();
  function frame(now: number) {
    const t = Math.min(1, (now - start) / duration);
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    el.textContent = formatFn(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Toast stack (#20) ────────────────────────────────────────────────────────

let _toastCounter = 0;
function toast(msg: string, type: "info" | "success" | "error", hash?: string) {
  const stack = $("toast-stack");
  // Remove oldest if already 3
  while (stack.children.length >= 3) stack.removeChild(stack.firstChild!);
  const id = `toast-${++_toastCounter}`;
  const el = document.createElement("div");
  el.id = id;
  el.className = `toast toast-${type}`;
  el.setAttribute("role", "alert");
  const icon = type === "success" ? "\u2713" : type === "error" ? "\u2717" : "\u27F3";
  const linkHtml = hash
    ? ` <a class="toast-link" href="https://stellar.expert/explorer/public/tx/${hash}" target="_blank" rel="noopener">View \u2192</a>`
    : "";
  el.innerHTML = `<span>${icon}</span><span>${msg}</span>${linkHtml}`;
  stack.appendChild(el);
  const timeout = type === "error" ? 9000 : 5000;
  setTimeout(() => { const t = document.getElementById(id); if (t) t.remove(); }, timeout);
}

// ── TX History (#16) ─────────────────────────────────────────────────────────

const TX_HISTORY_KEY = "blendlev_tx_history";
const TX_HISTORY_MAX = 10;

function addTxToHistory(label: string, hash: string, status: "success" | "error") {
  const history = getTxHistory();
  history.unshift({ label, hash, status, time: Date.now() });
  if (history.length > TX_HISTORY_MAX) history.pop();
  localStorage.setItem(TX_HISTORY_KEY, JSON.stringify(history));
  renderTxHistory();
}

function getTxHistory(): Array<{ label: string; hash: string; status: string; time: number }> {
  const raw = localStorage.getItem(TX_HISTORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

function renderTxHistory() {
  const list = $("tx-history-list");
  const history = getTxHistory();
  if (history.length === 0) { $("tx-history").style.display = "none"; return; }
  $("tx-history").style.display = "";
  list.innerHTML = history.map(tx => {
    const ago = Math.round((Date.now() - tx.time) / 60000);
    const timeStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
    return `<div class="tx-history-item">
      <span class="tx-history-status-${tx.status === "success" ? "ok" : "err"}">${tx.status === "success" ? "\u2713" : "\u2717"}</span>
      <span class="tx-history-label">${tx.label}</span>
      <span class="tx-history-time">${timeStr}</span>
      <a class="tx-history-link" href="https://stellar.expert/explorer/public/tx/${tx.hash}" target="_blank" rel="noopener">View</a>
    </div>`;
  }).join("");
}

// ── TX Stepper (#10) ─────────────────────────────────────────────────────────

let _stepperTimer: ReturnType<typeof setTimeout> | null = null;

function showTxStepper(steps: string[]) {
  const el = $("tx-stepper");
  el.innerHTML = steps.map((label, i) =>
    `${i > 0 ? '<div class="tx-step-connector"></div>' : ''}` +
    `<div class="tx-step" id="tx-step-${i}">` +
    `<span class="tx-step-num">${i + 1}</span>` +
    `<span>${label}</span></div>`
  ).join("");
  el.classList.remove("hidden");
  if (_stepperTimer) clearTimeout(_stepperTimer);
}

function updateTxStep(index: number, state: "active" | "done" | "error") {
  const step = document.getElementById(`tx-step-${index}`);
  if (!step) return;
  step.className = `tx-step ${state}`;
  const num = step.querySelector(".tx-step-num")!;
  if (state === "done") num.textContent = "\u2713";
  else if (state === "error") num.textContent = "\u2717";
  if (state === "active") {
    const existing = step.querySelector(".tx-step-spinner");
    if (!existing) { const sp = document.createElement("span"); sp.className = "tx-step-spinner"; step.appendChild(sp); }
  }
}

function hideTxStepper(delay = 3000) {
  _stepperTimer = setTimeout(() => $("tx-stepper").classList.add("hidden"), delay);
}

function markStepperError(totalSteps: number) {
  for (let i = 0; i < totalSteps; i++) {
    const s = document.getElementById(`tx-step-${i}`);
    if (s && !s.classList.contains("done")) { updateTxStep(i, "error"); break; }
  }
  hideTxStepper(6000);
}

// ── PnL tracking (#15) ──────────────────────────────────────────────────────

function savePnlEntry(assetId: string, poolId: string, deposit: number) {
  const key = `pnl_${poolId}_${assetId}`;
  localStorage.setItem(key, JSON.stringify({ deposit, timestamp: Date.now() }));
}
function getPnlEntry(assetId: string, poolId: string): { deposit: number; timestamp: number } | null {
  const raw = localStorage.getItem(`pnl_${poolId}_${assetId}`);
  return raw ? JSON.parse(raw) : null;
}
function removePnlEntry(assetId: string, poolId: string) {
  localStorage.removeItem(`pnl_${poolId}_${assetId}`);
}

// ── Sign + submit ─────────────────────────────────────────────────────────────

async function signAndSubmit(xdrStr: string, label: string, stepIndex?: number): Promise<string> {
  if (stepIndex !== undefined) updateTxStep(stepIndex, "active");
  toast(`Sign "${label}" in your wallet\u2026`, "info");
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdrStr, {
    networkPassphrase: getNetworkPassphrase(),
    address: userAddress!,
  });
  toast(`Submitting "${label}"\u2026`, "info");
  const hash = await submitSignedXdr(signedTxXdr);
  if (stepIndex !== undefined) updateTxStep(stepIndex, "done");
  toast(`"${label}" confirmed!`, "success", hash);
  addTxToHistory(label, hash, "success");
  return hash;
}

// ── Pool tabs ─────────────────────────────────────────────────────────────────

function buildPoolTabs() {
  // Mobile sidebar pool tabs
  const container = $("pool-tabs");
  container.innerHTML = "";
  getKnownPools().forEach(pool => {
    const btn = document.createElement("button");
    const isFrozen = pool.status !== 1;
    btn.className = `pool-tab ${pool.id === selectedPool.id ? "active" : ""} ${isFrozen ? "pool-tab-frozen" : ""}`;
    btn.dataset["poolId"] = pool.id;
    btn.textContent = pool.name;
    btn.setAttribute("role", "tab");
    if (isFrozen) btn.setAttribute("data-tip", "Admin Frozen \u2014 exploited Feb 2026");
    btn.addEventListener("click", () => selectPool(pool));
    container.appendChild(btn);
  });

  // Desktop pool dropdown
  const dropdown = $("pool-dropdown");
  dropdown.innerHTML = "";
  getKnownPools().forEach(pool => {
    const btn = document.createElement("button");
    const isFrozen = pool.status !== 1;
    btn.className = `pool-dropdown-item ${pool.id === selectedPool.id ? "active" : ""} ${isFrozen ? "pool-tab-frozen" : ""}`;
    btn.dataset["poolId"] = pool.id;
    btn.textContent = pool.name;
    if (isFrozen) btn.setAttribute("data-tip", "Admin Frozen \u2014 exploited Feb 2026");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPool(pool);
      dropdown.classList.add("hidden");
    });
    dropdown.appendChild(btn);
  });

  // Update Trade button text to show current pool
  const tradeBtn = $("proto-blend");
  tradeBtn.innerHTML = `${selectedPool.name} <span class="nav-caret">&#9662;</span>`;
}

function selectPool(pool: PoolDef) {
  selectedPool = pool;

  document.querySelectorAll<HTMLButtonElement>(".pool-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["poolId"] === pool.id);
  });
  document.querySelectorAll<HTMLButtonElement>(".pool-dropdown-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["poolId"] === pool.id);
  });

  // Update Trade button text
  const tradeBtn = $("proto-blend");
  tradeBtn.innerHTML = `${pool.name} <span class="nav-caret">&#9662;</span>`;

  const banner = $("pool-frozen-banner");
  if (pool.status !== 1) {
    banner.classList.remove("hidden");
    ($("open-btn") as HTMLButtonElement).disabled = true;
  } else {
    banner.classList.add("hidden");
  }

  assets = getPoolAssets(pool);
  selectedAsset = assets[0];

  buildAssetTabs();
  ($("asset-symbol-suffix") as HTMLElement).textContent = selectedAsset.symbol;
  updateLeverageSlider(selectedAsset.cFactor);

  renderPoolFooter();
  closeDrawer();

  if (userAddress) loadAll();
}

// ── Asset tabs ────────────────────────────────────────────────────────────────

/** Set leverage slider min/max/step based on asset cFactor and lFactor. */
function updateLeverageSlider(c: number, l: number = 1) {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const maxLev = Math.floor(maxLeverageFor(c, l, minHF()) * 10) / 10; // floor to 1 decimal
  // Looping requires the same asset to be both collateral (c > 0) and borrowable (l > 0).
  // If either is 0 the pool blocks one side and maxLev collapses to 1.0 — disable the slider
  // and surface an accurate notice instead of leaving min == max (appearing stuck).
  const leverageable = maxLev > 1.0;
  slider.min = numIn.min = "1.0";
  slider.max = numIn.max = String(leverageable ? maxLev : 1.0);
  slider.step = numIn.step = "0.1";
  slider.disabled = numIn.disabled = !leverageable;
  const cur = parseFloat(slider.value);
  const clamped = Math.min(parseFloat(slider.max), Math.max(1.0, cur));
  if (clamped !== cur) { slider.value = String(clamped); numIn.value = String(clamped); }
  // Gradient track (#9)
  slider.style.background = leverageable
    ? `linear-gradient(90deg, var(--success) 0%, var(--primary) 33%, var(--warning) 66%, var(--danger) 100%)`
    : `var(--surface-2)`;
  const notice = document.getElementById("non-borrowable-notice");
  if (notice) {
    notice.classList.toggle("hidden", leverageable);
    const sym = selectedAsset.symbol;
    notice.textContent = c <= 0
      ? `⚠ ${sym} is borrow-only on this pool — cannot be used as collateral, so looping is not available.`
      : l <= 0
        ? `⚠ ${sym} is collateral-only on this pool — cannot be borrowed, so looping is not available.`
        : `⚠ ${sym} cannot be looped on this pool.`;
  }
}

function buildAssetTabs() {
  const container = $("asset-tabs");
  container.innerHTML = "";
  assets.forEach(asset => {
    const btn = document.createElement("button");
    btn.className = `asset-tab ${asset.id === selectedAsset.id ? "active" : ""}`;
    btn.dataset["assetId"] = asset.id;
    btn.innerHTML = `<span class="tab-symbol">${asset.symbol}</span>`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", asset.id === selectedAsset.id ? "true" : "false");
    btn.addEventListener("click", () => selectAsset(asset));
    container.appendChild(btn);
  });
}

function selectAsset(asset: AssetInfo) {
  selectedAsset = asset;
  document.querySelectorAll<HTMLButtonElement>(".asset-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset["assetId"] === asset.id);
    btn.setAttribute("aria-selected", btn.dataset["assetId"] === asset.id ? "true" : "false");
  });
  ($("asset-symbol-suffix") as HTMLElement).textContent = asset.symbol;

  const rs = reserves.find(r => r.asset.id === asset.id);
  updateLeverageSlider(rs ? rs.cFactor : asset.cFactor, rs?.lFactor ?? 1);

  renderSelectedAsset();
  if (userAddress) refreshTabData();
}

/** Fetch only balance for the current asset (BLND is pool-wide, fetched in loadAll). */
async function refreshTabData() {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;
  } catch { /* silently ignore */ }
}

// ── HF Gauge (#7) ────────────────────────────────────────────────────────────

function renderHFGauge(hf: number): string {
  const cx = 60, cy = 55, r = 45;
  const clampedHF = Math.max(1.0, Math.min(1.3, isFinite(hf) ? hf : 1.3));
  const pct = (clampedHF - 1.0) / 0.3;
  const angle = Math.PI * (1 - pct);
  const nx = cx + r * Math.cos(angle);
  const ny = cy - r * Math.sin(angle);
  const color = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";
  const textColor = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";
  const bgArc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const largeArc = pct > 0.5 ? 1 : 0;
  const fillArc = `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${nx.toFixed(1)} ${ny.toFixed(1)}`;

  return `<svg class="hf-gauge" viewBox="0 0 120 65" width="120" height="65">
    <path d="${bgArc}" fill="none" stroke="var(--hf-bar-bg)" stroke-width="8" stroke-linecap="round"/>
    <path d="${fillArc}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
    <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="${color}"/>
    <text x="${cx}" y="${cy + 2}" text-anchor="middle" class="hf-gauge-text ${textColor}">${isFinite(hf) ? fmt(hf, 3) : "\u221E"}</text>
  </svg>`;
}

// ── Liquidation countdown ring (#18) ─────────────────────────────────────────

function renderLiqCountdownRing(days: number, maxDays = 365): string {
  const r = 18, cx = 22, cy = 22, stroke = 4;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, days / maxDays));
  const offset = circumference * (1 - pct);
  const color = days < 7 ? "var(--danger)" : days < 30 ? "var(--warning)" : "var(--success)";
  const pulse = days < 7 ? ' class="liq-ring-pulse"' : '';
  return `<svg width="44" height="44" viewBox="0 0 44 44"${pulse}>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hf-bar-bg)" stroke-width="${stroke}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
  </svg>`;
}

// ── APY Chart (#14) ──────────────────────────────────────────────────────────

function renderApyChart(rs: ReserveStats | undefined, currentLev: number, equity: number, oldSupply = 0, oldBorrow = 0) {
  const container = $("apy-chart");
  if (!rs) { container.innerHTML = ""; return; }
  const maxLev = parseFloat(($("leverage-slider") as HTMLInputElement).max);
  const W = 300, H = 120, padL = 34, padR = 10, padT = 14, padB = 15;
  const steps: { lev: number; apy: number }[] = [];
  for (let l = 1.0; l <= maxLev; l += 0.2) {
    const p = projectRates(rs, equity * l - oldSupply, equity * (l - 1) - oldBorrow);
    steps.push({ lev: l, apy: aprToApy(p.netSupplyApr * l - p.netBorrowCost * (l - 1)) });
  }
  if (steps.length < 2) { container.innerHTML = ""; return; }
  const minApy = Math.min(0, ...steps.map(s => s.apy));
  const maxApy = Math.max(1, ...steps.map(s => s.apy));
  const rangeApy = maxApy - minApy || 1;
  const x = (lev: number) => padL + (lev - 1.0) / (maxLev - 1.0) * (W - padL - padR);
  const y = (apy: number) => padT + (1 - (apy - minApy) / rangeApy) * (H - padT - padB);
  const points = steps.map(s => `${x(s.lev).toFixed(1)},${y(s.apy).toFixed(1)}`).join(" ");
  const curProj = projectRates(rs, equity * currentLev - oldSupply, equity * (currentLev - 1) - oldBorrow);
  const curApy = aprToApy(curProj.netSupplyApr * currentLev - curProj.netBorrowCost * (currentLev - 1));
  const zeroY = y(0);

  // Position the label above or below the dot to avoid clipping
  const dotCx = x(currentLev).toFixed(1);
  const dotCy = Number(y(curApy).toFixed(1));
  const labelAbove = dotCy > padT + 14;
  const labelY = labelAbove ? dotCy - 8 : dotCy + 14;
  // Clamp label X so it doesn't overflow left/right
  const labelX = Math.max(padL + 15, Math.min(W - padR - 15, Number(dotCx)));

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="overflow:visible">
    <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" class="apy-chart-zero"/>
    <polyline points="${points}" class="apy-chart-line"/>
    <circle cx="${dotCx}" cy="${dotCy}" r="4" class="apy-chart-dot"/>
    <text x="${padL - 2}" y="${padT + 8}" text-anchor="end" class="apy-chart-label">${fmt(maxApy, 0)}%</text>
    <text x="${padL - 2}" y="${H - padB + 2}" text-anchor="end" class="apy-chart-label">${fmt(minApy, 0)}%</text>
    <text x="${labelX}" y="${labelY}" text-anchor="middle" class="apy-chart-label apy-chart-cur">${fmt(curApy, 2)}%</text>
  </svg>`;
}

// ── Render reserve stats for selected asset ───────────────────────────────────

function renderSelectedAsset() {
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  if (!rs) return;

  // Clear skeletons (#3)
  ["stat-cfactor","stat-max-lev","stat-liquidity","stat-util","stat-price",
   "supply-interest-apr","supply-blnd-apr","supply-net-apr","borrow-interest-apr","borrow-blnd-apr","borrow-net-cost"]
    .forEach(clearSkeleton);

  updateLeverageSlider(rs.cFactor, rs.lFactor);

  const maxLev = maxLeverageFor(rs.cFactor, rs.lFactor, minHF());
  $("stat-cfactor").textContent    = `${(rs.cFactor * 100).toFixed(0)}%`;
  $("stat-max-lev").textContent    = `${maxLev.toFixed(2)}\u00D7`;
  $("stat-liquidity").textContent  = `${fmt(rs.available, 0)} ${rs.asset.symbol}`;

  // Utilization display with color coding
  const util = rs.totalSupply > 0 ? rs.totalBorrow / rs.totalSupply : 0;
  const utilEl = $("stat-util");
  utilEl.textContent = `${(util * 100).toFixed(1)}%`;
  utilEl.className = `stat-value ${util > 0.90 ? "hf-bad" : util > 0.75 ? "hf-warn" : ""}`;

  // Utilization bar (#13)
  const utilBar = $("util-bar");
  utilBar.style.width = `${(util * 100).toFixed(1)}%`;
  utilBar.style.background = util > 0.90 ? "var(--danger)" : util > 0.75 ? "var(--warning)" : "var(--success)";

  $("stat-price").textContent      = rs.priceUsd > 0 ? `$${fmt(rs.priceUsd, 4)}` : "\u2014";

  renderAprLine("supply-interest-apr", rs.interestSupplyApr, false);
  renderAprLine("supply-blnd-apr",     rs.blndSupplyApr,     false, true);
  renderAprLine("supply-net-apr",      aprToApy(rs.interestSupplyApr) + rs.blndSupplyApr, false, false, undefined, true);
  renderAprLine("borrow-interest-apr", rs.interestBorrowApr, true);
  renderAprLine("borrow-blnd-apr",     rs.blndBorrowApr,     false, true, "-");
  renderAprLine("borrow-net-cost",     aprToApy(rs.interestBorrowApr) - rs.blndBorrowApr, true, false, undefined, true);

  // Update net tooltips with actual APR
  const supplyTip = $("supply-net-tip");
  if (supplyTip) supplyTip.setAttribute("data-tip",
    `Approximate APY: interest compounds but BLND emissions don't. Actual net APR: ${fmt(rs.netSupplyApr, 2)}%`);
  const borrowTip = $("borrow-net-tip");
  if (borrowTip) borrowTip.setAttribute("data-tip",
    `Approximate APY: interest compounds but BLND emissions don't. Actual net APR: ${fmt(rs.netBorrowCost, 2)}%`);

  // Don't auto-collapse — user controls visibility via the toggle

  updatePreview();
  renderPosition();
  renderPortfolioSummary();
}

function renderAprLine(id: string, val: number, isCost: boolean, isBlnd = false, sign?: string, raw = false) {
  const el = $(id);
  if (!el) return;
  const display = (isBlnd || raw) ? val : aprToApy(val);
  const prefix = sign ?? (display >= 0 ? "+" : "-");
  el.textContent = `${prefix}${fmt(Math.abs(display), 2)}%`;
  el.className = "apr-val " + (
    isBlnd ? "apr-blnd" :
    isCost ? (display > 5 ? "apr-bad" : display > 2 ? "apr-warn" : "apr-ok") :
             (display > 5 ? "apr-great" : display > 2 ? "apr-ok" : "apr-dim")
  );
}

// ── Pool-wide health factor ───────────────────────────────────────────────────

function computePoolHF(): number {
  let weightedCollateral = 0;
  let totalDebt          = 0;
  for (const pos of positions.byAsset.values()) {
    const rs = reserves.find(r => r.asset.id === pos.asset.id);
    if (!rs) continue;
    weightedCollateral += pos.collateral * rs.cFactor * rs.priceUsd;
    totalDebt          += (pos.debt / rs.lFactor) * rs.priceUsd;
  }
  return totalDebt > 0 ? weightedCollateral / totalDebt : Infinity;
}

// ── Portfolio summary (#8) ───────────────────────────────────────────────────

function renderPortfolioSummary() {
  const container = $("portfolio-summary");
  if (positions.byAsset.size === 0) { container.classList.add("hidden"); return; }
  container.classList.remove("hidden");
  container.innerHTML = "";
  for (const [assetId, pos] of positions.byAsset) {
    const rs = reserves.find(r => r.asset.id === assetId);
    const cardNetApr = rs ? rs.netSupplyApr * pos.leverage - rs.netBorrowCost * (pos.leverage - 1) : 0;
    const netApy = aprToApy(cardNetApr);
    const hfColor = pos.hf > 1.1 ? "var(--success)" : pos.hf > 1.03 ? "var(--warning)" : "var(--danger)";
    const card = document.createElement("div");
    card.className = `portfolio-card ${assetId === selectedAsset.id ? "active" : ""}`;
    card.title = `Approximate APY — Blend does not auto-compound. Actual net APR: ${fmt(cardNetApr, 2)}%`;
    card.innerHTML = `
      <span class="portfolio-card-hf-dot" style="background:${hfColor};box-shadow:0 0 6px ${hfColor}"></span>
      <span class="portfolio-card-symbol">${pos.asset.symbol}</span>
      <span class="portfolio-card-details">
        <span>${fmt(pos.equity, 2)} equity \u00B7 ${fmt(pos.leverage, 1)}\u00D7</span>
        <span>APY ${netApy >= 0 ? "+" : ""}${fmt(netApy, 2)}% \u00B7 HF ${fmt(pos.hf, 2)}</span>
      </span>`;
    card.addEventListener("click", () => {
      const asset = assets.find(a => a.id === assetId);
      if (asset) selectAsset(asset);
    });
    container.appendChild(card);
  }
}

// ── Pool footer (#19) ────────────────────────────────────────────────────────

function renderPoolFooter() {
  const footer = $("pool-footer");
  const addr = selectedPool.id;
  const truncated = addr.slice(0, 6) + "\u2026" + addr.slice(-4);
  footer.innerHTML = `
    <span>Pool: <a href="https://stellar.expert/explorer/public/contract/${addr}" target="_blank" rel="noopener" class="mono">${truncated}</a></span>
    <span>\u00B7</span>
    <a href="https://docs.blend.capital/" target="_blank" rel="noopener">Blend Docs</a>
    <span>\u00B7</span>
    <a href="https://github.com/blend-capital" target="_blank" rel="noopener">GitHub</a>
  `;
}

// ── Position display ──────────────────────────────────────────────────────────

function renderPosition() {
  const pos = positions.byAsset.get(selectedAsset.id);

  if (!pos) {
    $("no-position").classList.remove("hidden");
    $("position-data").classList.add("hidden");
    $("metrics-hero").classList.add("hidden");
    ($("close-btn") as HTMLButtonElement).disabled = true;
    ($("repay-btn") as HTMLButtonElement).disabled = true;
    ($("resupply-btn") as HTMLButtonElement).disabled = true;
    // Clear stale compound estimate from previous asset
    $("compound-estimate").textContent = "";
    ($("compound-btn") as HTMLButtonElement).disabled = true;
    // Show Open mode
    setActionCardMode("open");
    return;
  }

  // Clear position skeletons (#3)
  ["pos-collateral","pos-debt","pos-equity","pos-leverage","pos-hf","pos-pool-hf","pos-net-apr","pos-headroom","pos-liq-days"]
    .forEach(clearSkeleton);

  $("no-position").classList.add("hidden");
  $("position-data").classList.remove("hidden");
  $("metrics-hero").classList.remove("hidden");
  ($("close-btn") as HTMLButtonElement).disabled = false;
  ($("repay-btn") as HTMLButtonElement).disabled = pos.dTokens === 0n;
  ($("resupply-btn") as HTMLButtonElement).disabled = false;
  // Show Adjust mode
  setActionCardMode("adjust", pos);

  $("pos-collateral").textContent = `${fmt(pos.collateral, 4)} ${pos.asset.symbol}`;
  $("pos-debt").textContent       = `${fmt(pos.debt, 4)} ${pos.asset.symbol}`;

  // Equity with PnL (#15)
  const pnl = getPnlEntry(selectedAsset.id, selectedPool.id);
  if (pnl) {
    const unrealizedPnl = pos.equity - pnl.deposit;
    const pnlPct = pnl.deposit > 0 ? (unrealizedPnl / pnl.deposit * 100) : 0;
    const pnlColor = unrealizedPnl >= 0 ? "hf-ok" : "hf-bad";
    $("pos-equity").innerHTML = `${fmt(pos.equity, 4)} ${pos.asset.symbol} <span class="${pnlColor}" style="font-size:11px">(${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl, 4)} / ${unrealizedPnl >= 0 ? "+" : ""}${fmt(pnlPct, 1)}%)</span>`;
  } else {
    $("pos-equity").textContent     = `${fmt(pos.equity, 4)} ${pos.asset.symbol}`;
  }

  // Animated leverage (#11)
  animateNumber($("pos-leverage"), pos.leverage, 200, n => `${fmt(n, 2)}\u00D7`);

  // Hero metrics
  const hf = pos.hf;
  const heroHf = $("hero-hf");
  heroHf.textContent = isFinite(hf) ? fmt(hf, 3) : "\u221E";
  heroHf.className = `metric-hero-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
  $("hero-leverage").textContent = `${fmt(pos.leverage, 2)}\u00D7`;

  // Per-asset health factor with icon (#22)
  const hfEl = $("pos-hf");
  const hfIcon = hf > 1.1 ? "\u2713" : hf > 1.03 ? "\u26A0" : "\u2717";
  const hfDec = expertMode ? 5 : 3;
  hfEl.textContent = `${hfIcon} ${isFinite(hf) ? fmt(hf, hfDec) : "\u221E"}`;
  hfEl.className   = `metric-value ${hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad"}`;
  const barPct = Math.min(100, Math.max(0, (hf - 1) / 0.3 * 100));
  const bar = $("hf-bar");
  bar.style.width      = `${barPct}%`;
  bar.style.background = hf > 1.1 ? "var(--success)" : hf > 1.03 ? "var(--warning)" : "var(--danger)";

  // ARIA on HF bar (#6)
  const barWrap = $("hf-bar").parentElement!;
  barWrap.setAttribute("aria-valuenow", String(Math.round(barPct)));
  barWrap.setAttribute("aria-label", `Health factor ${isFinite(hf) ? fmt(hf, 3) : "infinity"}`);

  // HF Gauge (#7)
  const gaugeEl = document.querySelector(".hf-gauge-container") as HTMLElement;
  if (gaugeEl) gaugeEl.innerHTML = renderHFGauge(hf);

  // HF warning banner (#2) — only show below 1.01
  const warnEl = $("hf-pos-warning");
  if (isFinite(hf) && hf < 1.01) {
    const isDanger = hf < 1.003;
    warnEl.className = `hf-pos-warning ${isDanger ? "hf-danger-level" : "hf-warn-level"}`;
    warnEl.innerHTML = `
      <span>${isDanger ? "\u2717" : "\u26A0"} Health Factor is ${fmt(hf, 3)} \u2014 ${isDanger ? "liquidation imminent!" : "approaching liquidation"}</span>
      <div class="hf-warn-actions">
        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('repay-btn').click()">Repay</button>
        <button class="btn btn-sm btn-secondary" onclick="document.getElementById('resupply-btn').click()">Resupply</button>
      </div>`;
    warnEl.classList.remove("hidden");
  } else {
    warnEl.classList.add("hidden");
  }

  // Pool-wide health factor with icon (#22)
  const poolHF   = computePoolHF();
  const poolHFEl = $("pos-pool-hf");
  const poolIcon = poolHF > 1.1 ? "\u2713" : poolHF > 1.03 ? "\u26A0" : "\u2717";
  poolHFEl.textContent = `${poolIcon} ${isFinite(poolHF) ? fmt(poolHF, 3) : "\u221E"}`;
  poolHFEl.className   = `metric-value ${poolHF > 1.1 ? "hf-ok" : poolHF > 1.03 ? "hf-warn" : "hf-bad"}`;

  // Borrow headroom
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const headroomEl = $("pos-headroom");
  if (rs && rs.priceUsd > 0) {
    const effectiveCollateral = pos.collateral * rs.cFactor;
    const effectiveDebt       = pos.debt / rs.lFactor;
    const headroom  = Math.max(0, effectiveCollateral - effectiveDebt) * rs.priceUsd;
    headroomEl.textContent = `$${fmt(headroom, 2)}`;
    headroomEl.className   = `metric-value mono ${headroom < 5 ? "hf-bad" : headroom < 20 ? "hf-warn" : ""}`;
  } else {
    headroomEl.textContent = "\u2014";
    headroomEl.className   = "metric-value mono";
  }

  // Net APY with icon (#22)
  const netAprEl = $("pos-net-apr");
  const heroApyEl = $("hero-net-apy");
  if (rs && pos.leverage > 0) {
    const posNetApr = rs.netSupplyApr * pos.leverage - rs.netBorrowCost * (pos.leverage - 1);
    const netApy = aprToApy(posNetApr);
    const apyIcon = netApy > 0 ? "\u2713" : "\u2717";
    netAprEl.textContent = `${apyIcon} ${netApy >= 0 ? "+" : ""}${fmt(netApy, 2)}%`;
    netAprEl.className   = `metric-value ${netApy > 0 ? "hf-ok" : "hf-bad"}`;
    // Hero APY
    heroApyEl.textContent = `${netApy >= 0 ? "+" : ""}${fmt(netApy, 2)}%`;
    heroApyEl.className   = `metric-hero-value ${netApy > 0 ? "hf-ok" : "hf-bad"}`;
    // Tooltips with actual APR
    const aprTip = `Approximate APY — Blend interest does not auto-compound. Actual net APR: ${fmt(posNetApr, 2)}%`;
    const posTip = $("pos-net-apr-tip");
    if (posTip) posTip.setAttribute("data-tip", aprTip);
    const heroTip = $("hero-net-apy-tip");
    if (heroTip) heroTip.setAttribute("data-tip", aprTip);
  } else {
    netAprEl.textContent = "\u2014";
    netAprEl.className   = "metric-value";
    heroApyEl.textContent = "\u2014";
    heroApyEl.className   = "metric-hero-value";
  }

  // Days until liquidation with ring (#18)
  const liqDaysEl  = $("pos-liq-days");
  const liqNoteEl  = $("pos-liq-note");
  if (rs && pos.leverage > 0 && isFinite(pos.hf) && pos.hf > 1) {
    const spreadPct = rs.interestBorrowApr - rs.interestSupplyApr;
    if (spreadPct <= 0) {
      liqDaysEl.textContent = "Never (supply rate \u2265 borrow rate)";
      liqDaysEl.className   = "metric-value hf-ok";
      liqNoteEl.textContent = "";
    } else {
      const daysLeft = Math.log(pos.hf) / (spreadPct / 100) * 365;
      if (daysLeft <= 365) {
        liqDaysEl.innerHTML = `<span class="liq-countdown-wrap">${renderLiqCountdownRing(daysLeft)} <span>~${Math.round(daysLeft)} days</span></span>`;
      } else {
        liqDaysEl.textContent = daysLeft > 3650 ? ">10 years" : `~${Math.round(daysLeft)} days`;
      }
      liqDaysEl.className   = `metric-value ${daysLeft < 30 ? "hf-bad" : daysLeft < 90 ? "hf-warn" : "hf-ok"}`;
      liqNoteEl.textContent = `Interest spread: ${fmt(aprToApy(spreadPct), 2)}%/yr (borrow \u2212 supply). Claim & convert BLND to extend runway.`;
    }
  } else {
    liqDaysEl.textContent = "\u2014";
    liqDaysEl.className   = "metric-value";
    liqNoteEl.textContent = "";
  }

  // Compound row: show swap estimate if there's pending BLND
  updateCompoundEstimate();
}

async function updateCompoundEstimate() {
  const compoundBtn = $("compound-btn") as HTMLButtonElement;
  const estimateEl  = $("compound-estimate");

  // Check pending BLND from the displayed value
  const blndText = $("pos-blnd").textContent ?? "";
  const blndMatch = blndText.match(/([\d.]+)/);
  const pendingBlnd = blndMatch ? parseFloat(blndMatch[1]) : 0;

  if (pendingBlnd <= 0 || !positions.byAsset.has(selectedAsset.id)) {
    estimateEl.textContent = "";
    compoundBtn.disabled = true;
    return;
  }

  estimateEl.textContent = "\u2192 estimating\u2026";
  compoundBtn.disabled = true;

  try {
    const est = await estimateBlndSwap(pendingBlnd, selectedAsset.id);
    if (est) {
      estimateEl.textContent = `\u2192 ~${fmt(est.estimate, 4)} ${selectedAsset.symbol}`;
      compoundBtn.disabled = false;
    } else {
      estimateEl.textContent = "(no swap path)";
      compoundBtn.disabled = true;
    }
  } catch {
    estimateEl.textContent = "";
    compoundBtn.disabled = true;
  }
}

// ── Open / Adjust mode switching ──────────────────────────────────────────

let actionMode: "open" | "adjust" | "add-funds" = "open";

function setActionCardMode(mode: "open" | "adjust", pos?: AssetPosition) {
  // When switching to adjust, default to the "adjust leverage" sub-tab
  actionMode = mode === "adjust" ? "adjust" : "open";
  const isAdjust = mode === "adjust";

  $("action-card-title").textContent = isAdjust ? "Adjust Position" : "Open Position";
  $("adjust-tabs").classList.toggle("hidden", !isAdjust);
  $("open-deposit-group").classList.toggle("hidden", isAdjust);
  $("adjust-current").classList.toggle("hidden", !isAdjust);
  $("add-funds-group").classList.add("hidden");
  $("open-btn").classList.toggle("hidden", isAdjust);
  $("adjust-btn").classList.toggle("hidden", !isAdjust);
  $("add-funds-btn").classList.add("hidden");
  $("open-disclaimer").classList.toggle("hidden", isAdjust);
  $("adjust-disclaimer").classList.toggle("hidden", !isAdjust);
  $("add-funds-disclaimer").classList.add("hidden");

  // Reset adjust sub-tabs to "Adjust Leverage"
  document.querySelectorAll<HTMLButtonElement>(".adjust-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.adjust === "leverage");
  });

  if (isAdjust && pos) {
    $("adjust-current-lev").textContent = `${fmt(pos.leverage, 2)}\u00D7`;
    $("leverage-label").textContent = "Target leverage";
    $("add-funds-symbol").textContent = pos.asset.symbol;
    // Set slider to current leverage
    const slider = $("leverage-slider") as HTMLInputElement;
    const numIn  = $("leverage-input")  as HTMLInputElement;
    const curLev = Math.round(pos.leverage * 10) / 10;
    slider.value = String(curLev);
    numIn.value  = curLev.toFixed(1);
  } else {
    $("leverage-label").innerHTML = 'Leverage <span class="tooltip" data-tip="Multiplier on your deposit. Higher leverage amplifies both yield and liquidation risk.">?</span>';
    initTooltips(); // Re-init tooltips for newly created elements
  }
  updatePreview();
}

function switchAdjustSubTab(sub: "leverage" | "add-funds") {
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  actionMode = sub === "leverage" ? "adjust" : "add-funds";

  document.querySelectorAll<HTMLButtonElement>(".adjust-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.adjust === sub);
  });

  const isAddFunds = sub === "add-funds";
  $("adjust-current").classList.toggle("hidden", isAddFunds);
  $("add-funds-group").classList.toggle("hidden", !isAddFunds);
  $("adjust-btn").classList.toggle("hidden", isAddFunds);
  $("add-funds-btn").classList.toggle("hidden", !isAddFunds);
  $("adjust-disclaimer").classList.toggle("hidden", isAddFunds);
  $("add-funds-disclaimer").classList.toggle("hidden", !isAddFunds);

  if (isAddFunds) {
    $("action-card-title").textContent = "Add Funds";
    $("leverage-label").innerHTML = 'Leverage <span class="tooltip" data-tip="Leverage for the new deposit. This deposit is added on top of your existing position.">?</span>';
    // Default leverage to current position leverage
    const slider = $("leverage-slider") as HTMLInputElement;
    const numIn  = $("leverage-input")  as HTMLInputElement;
    const curLev = Math.round(pos.leverage * 10) / 10;
    slider.value = String(curLev);
    numIn.value  = curLev.toFixed(1);
    $("add-funds-symbol").textContent = selectedAsset.symbol;
    // Fetch wallet balance for add-funds display
    if (userAddress) {
      fetchAssetBalance(userAddress, selectedAsset.id).then(bal => {
        $("add-funds-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;
      }).catch(() => {});
    }
    initTooltips();
  } else {
    $("action-card-title").textContent = "Adjust Position";
    $("leverage-label").textContent = "Target leverage";
    const slider = $("leverage-slider") as HTMLInputElement;
    const numIn  = $("leverage-input")  as HTMLInputElement;
    const curLev = Math.round(pos.leverage * 10) / 10;
    slider.value = String(curLev);
    numIn.value  = curLev.toFixed(1);
  }
  updatePreview();
}

// ── Leverage preview ──────────────────────────────────────────────────────────

function updatePreview() {
  const slider = $("leverage-slider") as HTMLInputElement;
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const lev    = parseFloat(slider.value) || 1.0;
  // Keep the number input in sync with the slider
  if (parseFloat(numIn.value) !== lev) numIn.value = lev.toFixed(1);
  const rs      = reserves.find(r => r.asset.id === selectedAsset.id);
  const c       = rs ? rs.cFactor : selectedAsset.cFactor;
  const l       = rs?.lFactor ?? 1;
  const hf      = hfForLeverage(lev, c, l);
  const pos     = positions.byAsset.get(selectedAsset.id);

  // In adjust mode, use equity as the base; in add-funds mode, use the add-funds input; in open mode, use initial deposit
  const equity  = (actionMode === "adjust" && pos) ? pos.equity
    : actionMode === "add-funds" ? (parseFloat(($("add-funds-input") as HTMLInputElement).value) || 0)
    : (parseFloat(($("initial-input") as HTMLInputElement).value) || 0);
  const supply  = equity * lev;
  const borrow  = equity * (lev - 1);

  // When adjusting an existing position, its supply/borrow are already in the
  // pool totals. Pass the net delta so projectRates doesn't double-count.
  const oldSupply = (actionMode === "adjust" && pos) ? pos.collateral : 0;
  const oldBorrow = (actionMode === "adjust" && pos) ? pos.debt : 0;

  $("prev-lev").textContent         = `${lev.toFixed(2)}\u00D7`;
  $("prev-supply").textContent      = `${fmt(supply, 2)} ${selectedAsset.symbol}`;
  $("prev-borrow").textContent      = `${fmt(borrow, 2)} ${selectedAsset.symbol}`;
  $("prev-hf").textContent          = isFinite(hf) ? fmt(hf, expertMode ? 5 : 4) : "\u221E";
  $("prev-hf").className            = hf > 1.1 ? "hf-ok" : hf > 1.03 ? "hf-warn" : "hf-bad";

  // Borrow headroom: how much more could be borrowed before liquidation
  if (rs && rs.priceUsd > 0) {
    const effectiveCollateral = supply * rs.cFactor;
    const effectiveDebt = borrow / (rs.lFactor ?? 1);
    const headroom = Math.max(0, effectiveCollateral - effectiveDebt) * rs.priceUsd;
    $("prev-headroom").textContent = `$${fmt(headroom, 2)}`;
    $("prev-headroom").className   = headroom < 5 ? "hf-bad" : headroom < 20 ? "hf-warn" : "";
  } else {
    $("prev-headroom").textContent = "\u2014";
    $("prev-headroom").className   = "";
  }

  if (rs) {
    const proj = projectRates(rs, supply - oldSupply, borrow - oldBorrow);
    const netApr = proj.netSupplyApr * lev - proj.netBorrowCost * (lev - 1);
    const netApy = aprToApy(netApr);
    $("prev-net-apr").textContent = `${fmt(netApy, 2)}% APY on equity`;
    $("prev-net-apr").className   = `prev-net-apr ${netApy > 0 ? "apr-great" : "apr-bad"}`;
    const prevTip = $("prev-net-tip");
    if (prevTip) prevTip.setAttribute("data-tip",
      `Approximate APY — Blend interest does not auto-compound. Actual net APR: ${fmt(netApr, 2)}%`);

    // Days until liquidation at this leverage (interest-only, no BLND)
    const spreadPct = proj.interestBorrowApr - proj.interestSupplyApr;
    const prevLiqEl = $("prev-liq-days");
    if (spreadPct <= 0) {
      prevLiqEl.textContent = "Never";
      prevLiqEl.className   = "hf-ok";
    } else if (isFinite(hf) && hf > 1) {
      const days = Math.log(hf) / (spreadPct / 100) * 365;
      prevLiqEl.textContent = days > 3650 ? ">10 years" : `~${Math.round(days)} days`;
      prevLiqEl.className   = days < 30 ? "hf-bad" : days < 90 ? "hf-warn" : "hf-ok";
    } else {
      prevLiqEl.textContent = "\u2014";
      prevLiqEl.className   = "";
    }

    // APY chart (#14)
    renderApyChart(rs, lev, equity, oldSupply, oldBorrow);
  }

  // Risk zone labels (#9)
  const maxSlider = parseFloat(($("leverage-slider") as HTMLInputElement).max) || 10;
  const atMax = Math.abs(lev - maxSlider) < 0.15;
  const zones = document.querySelectorAll<HTMLElement>(".slider-zone");
  const maxiDegenEl = $("zone-maxi-degen");
  if (expertMode) {
    maxiDegenEl?.classList.remove("hidden");
  } else {
    maxiDegenEl?.classList.add("hidden");
  }
  zones.forEach(z => {
    const zone = z.dataset.zone;
    const active =
      (zone === "maxi-degen" && expertMode && atMax) ||
      (!( expertMode && atMax) && (
        (zone === "conservative" && lev >= 1.0 && lev < 3) ||
        (zone === "moderate" && lev >= 3 && lev < 6) ||
        (zone === "aggressive" && lev >= 6 && lev < 9) ||
        (zone === "degen" && lev >= 9)
      ));
    z.classList.toggle("active", !!active);
  });

  // Liquidity check (for open and add-funds modes)
  const liquidityWarnEl = $("liquidity-warning") as HTMLElement;
  let liquidityOk = true;
  if (actionMode === "open" || actionMode === "add-funds") {
    const initial = equity;
    const totalBorrow = initial * (lev - 1);
    const cf = rs ? rs.cFactor : selectedAsset.cFactor;
    const firstBorrow = Math.min(initial * cf, totalBorrow);
    const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
    liquidityOk = !rs || firstBorrow <= poolAvailAfterDeposit;
    if (!liquidityOk && rs) {
      liquidityWarnEl.textContent = `\u26A0 First borrow (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage or deposit.`;
      liquidityWarnEl.classList.remove("hidden");
    } else {
      liquidityWarnEl.classList.add("hidden");
    }
  } else {
    liquidityWarnEl.classList.add("hidden");
  }

  const safe = hf >= minHF() && selectedPool.status === 1 && liquidityOk;
  ($("hf-warning") as HTMLElement).classList.toggle("hidden", hf >= minHF() || selectedPool.status !== 1);
  ($("open-btn") as HTMLButtonElement).disabled = !safe;

  // Adjust button: enabled if leverage changed and HF is safe
  if (actionMode === "adjust" && pos) {
    const curLev = Math.round(pos.leverage * 10) / 10;
    const changed = Math.abs(lev - curLev) >= 0.1;
    ($("adjust-btn") as HTMLButtonElement).disabled = !safe || !changed;
    ($("adjust-btn") as HTMLButtonElement).textContent =
      lev > curLev ? `Increase to ${lev.toFixed(1)}\u00D7` :
      lev < curLev ? `Decrease to ${lev.toFixed(1)}\u00D7` :
      "Adjust Leverage";
  }

  // Add Funds button: enabled if amount > 0 and HF is safe
  if (actionMode === "add-funds") {
    const addAmt = parseFloat(($("add-funds-input") as HTMLInputElement).value) || 0;
    ($("add-funds-btn") as HTMLButtonElement).disabled = !safe || addAmt <= 0;
    ($("add-funds-btn") as HTMLButtonElement).textContent = addAmt > 0
      ? `Add ${fmt(addAmt, 2)} ${selectedAsset.symbol} at ${lev.toFixed(1)}\u00D7`
      : "Add Funds";
  }
}

// ── Load data ─────────────────────────────────────────────────────────────────

let _loadInProgress = false;

async function loadAll() {
  if (!userAddress || _loadInProgress) return;
  _loadInProgress = true;

  // Show skeletons (#3)
  const skeletonIds = ["stat-cfactor","stat-max-lev","stat-liquidity","stat-util","stat-price",
    "supply-interest-apr","supply-blnd-apr","supply-net-apr","borrow-interest-apr","borrow-blnd-apr","borrow-net-cost",
    "pos-collateral","pos-debt","pos-equity","pos-leverage","pos-hf","pos-pool-hf","pos-net-apr","pos-headroom","pos-liq-days"];
  skeletonIds.forEach(setSkeleton);

  try {
    reserves  = await fetchAllReserves(selectedPool, userAddress);
    positions = await fetchUserPositions(selectedPool, userAddress, reserves);

    // Balance for selected asset
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("asset-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;

    // Pool-wide pending BLND (simulate claim for all positions in this pool)
    const blnd = await fetchPoolPendingBlnd(selectedPool, userAddress, positions);
    $("pos-blnd").textContent = `${fmt(blnd, 4)} BLND`;
    ($("claim-btn") as HTMLButtonElement).disabled = blnd <= 0;

    renderSelectedAsset();
    startFreshnessTimer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to load pool data:", e);
    toast(`Load failed: ${msg.slice(0, 120)}`, "error");
  } finally {
    _loadInProgress = false;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function openPosition() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  if (selectedPool.status !== 1) { toast("Pool is frozen \u2014 cannot open new positions", "error"); return; }
  const initial  = parseFloat(($("initial-input") as HTMLInputElement).value);
  const leverage = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  if (isNaN(initial) || initial <= 0) { toast("Enter a valid amount", "error"); return; }

  // Use live cFactor from reserves so intermediate borrow steps don't exceed pool limits
  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) { toast("HF too low \u2014 reduce leverage", "error"); return; }

  const totalBorrow   = initial * (leverage - 1);
  const firstBorrow   = Math.min(initial * liveAsset.cFactor, totalBorrow);
  const poolAvailAfterDeposit = (rs?.available ?? 0) + initial * (rs ? rs.asset.maxUtil : 0.95);
  if (rs && firstBorrow > poolAvailAfterDeposit) {
    toast(`First borrow step (${fmt(firstBorrow, 0)}) exceeds pool available after deposit (${fmt(poolAvailAfterDeposit, 0)} ${rs.asset.symbol}). Reduce leverage.`, "error");
    return;
  }

  const initialStroops = BigInt(Math.round(initial * 1e7));
  setLoading($("open-btn") as HTMLButtonElement, true);
  showTxStepper(["Approve", "Submit"]);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, liveAsset.id, initialStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`, 0);
    const submitXdr = await buildOpenPositionXdr(selectedPool, userAddress, liveAsset, initialStroops, leverage);
    await signAndSubmit(submitXdr, `Open ${liveAsset.symbol} leverage`, 1);
    hideTxStepper();
    savePnlEntry(liveAsset.id, selectedPool.id, initial);
    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    const msg: string = e?.message ?? "Transaction failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) {
      toast("Health factor too low \u2014 reduce leverage.", "error");
    } else if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization limit reached \u2014 not enough liquidity for this borrow. Reduce leverage or deposit.", "error");
    } else {
      toast(msg.slice(0, 200), "error");
    }
  } finally {
    setLoading($("open-btn") as HTMLButtonElement, false);
  }
}

async function closePosition() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;
  setLoading($("close-btn") as HTMLButtonElement, true);
  showTxStepper(["Close Position"]);
  try {
    const submitXdr = await buildCloseSubmitXdr(selectedPool, userAddress, pos);
    await signAndSubmit(submitXdr, `Close ${selectedAsset.symbol} position`, 0);
    hideTxStepper();
    removePnlEntry(selectedAsset.id, selectedPool.id);
    await loadAll();
  } catch (e: any) {
    const msg: string = e?.message ?? "";
    // Pool utilization too high for atomic close \u2014 fall back to two-step:
    // 1) Deleverage (repay debt using collateral, net flow \u2248 0)
    // 2) Withdraw remaining collateral (now debt-free, smaller supply impact)
    if ((msg.includes("#1207") || msg.includes("InvalidUtilRate")) && pos.dTokens > 0n) {
      try {
        toast("Pool utilization high \u2014 closing in two steps\u2026", "info");
        showTxStepper(["Repay Debt", "Withdraw Collateral"]);
        // Step 1: deleverage \u2014 repay all debt using collateral
        const repayXdr = await buildRepayXdr(selectedPool, userAddress, pos);
        await signAndSubmit(repayXdr, `Repay ${selectedAsset.symbol} debt`, 0);
        updateTxStep(0, "done");
        // Step 2: withdraw remaining collateral (no debt left)
        const withdrawXdr = await buildWithdrawXdr(selectedPool, userAddress, pos.asset.id);
        await signAndSubmit(withdrawXdr, `Withdraw ${selectedAsset.symbol} collateral`, 1);
        hideTxStepper();
        removePnlEntry(selectedAsset.id, selectedPool.id);
        await loadAll();
        return;
      } catch (e2: any) {
        const msg2: string = e2?.message ?? "Transaction failed";
        markStepperError(2);
        if (msg2.includes("#1207") || msg2.includes("InvalidUtilRate")) {
          toast("Pool utilization too high to withdraw all collateral. Debt was repaid \u2014 try withdrawing later when liquidity improves.", "error");
        } else {
          toast(msg2.slice(0, 200), "error");
        }
        await loadAll();
        return;
      }
    }
    markStepperError(1);
    if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization too high \u2014 not enough liquidity to close. Try again later.", "error");
    } else {
      toast(msg.slice(0, 200) || "Transaction failed", "error");
    }
  } finally {
    setLoading($("close-btn") as HTMLButtonElement, false);
  }
}

async function repayDebt() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos || pos.dTokens === 0n) return;
  setLoading($("repay-btn") as HTMLButtonElement, true);
  showTxStepper(["Repay Debt"]);
  try {
    const repayXdr = await buildRepayXdr(selectedPool, userAddress, pos);
    await signAndSubmit(repayXdr, `Repay ${selectedAsset.symbol} debt`, 0);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("repay-btn") as HTMLButtonElement, false);
  }
}

async function maxDeposit() {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    ($("initial-input") as HTMLInputElement).value = String(Math.floor(bal * 1e7) / 1e7);
    updatePreview();
  } catch { /* ignore */ }
}

async function claimBlnd() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  // Collect all token IDs for ALL positions in this pool
  const tokenIds: number[] = [];
  for (const pos of positions.byAsset.values()) {
    if (pos.bTokens > 0n) tokenIds.push(pos.asset.supplyTokenId);
    if (pos.dTokens > 0n) tokenIds.push(pos.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) { toast("No positions to claim from", "error"); return; }

  setLoading($("claim-btn") as HTMLButtonElement, true);
  showTxStepper(["Claim BLND"]);
  try {
    const claimXdr = await buildClaimXdr(selectedPool, userAddress, tokenIds);
    await signAndSubmit(claimXdr, "Claim BLND", 0);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    toast(e?.message ?? "Transaction failed", "error");
  } finally {
    setLoading($("claim-btn") as HTMLButtonElement, false);
  }
}

/** Adjust leverage on an existing position (increase or decrease). */
async function adjustLeverage() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  const targetLev = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  const curLev = pos.leverage;
  if (Math.abs(targetLev - curLev) < 0.05) { toast("Target leverage is same as current", "error"); return; }

  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(targetLev, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
    toast("HF too low at target leverage \u2014 reduce target", "error");
    return;
  }

  setLoading($("adjust-btn") as HTMLButtonElement, true);
  const direction = targetLev > curLev ? "Increase" : "Decrease";
  showTxStepper([`${direction} Leverage`]);
  try {
    if (targetLev > curLev) {
      const xdr = await buildIncreaseLeverageXdr(selectedPool, userAddress, liveAsset, pos, targetLev);
      await signAndSubmit(xdr, `Increase leverage to ${targetLev.toFixed(1)}\u00D7`, 0);
    } else {
      const xdr = await buildDecreaseLeverageXdr(selectedPool, userAddress, liveAsset, pos, targetLev);
      await signAndSubmit(xdr, `Decrease leverage to ${targetLev.toFixed(1)}\u00D7`, 0);
    }
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(1);
    const msg: string = e?.message ?? "Adjust leverage failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) {
      toast("Health factor too low — reduce target leverage.", "error");
    } else if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization limit reached — not enough liquidity. Reduce target leverage.", "error");
    } else {
      toast(msg.slice(0, 200), "error");
    }
  } finally {
    setLoading($("adjust-btn") as HTMLButtonElement, false);
  }
}

/** Add funds: deposit additional capital into an existing position at a chosen leverage. */
async function addFundsToPosition() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  if (selectedPool.status !== 1) { toast("Pool is frozen \u2014 cannot add funds", "error"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  const additional = parseFloat(($("add-funds-input") as HTMLInputElement).value);
  const leverage   = parseFloat(($("leverage-slider") as HTMLInputElement).value);
  if (isNaN(additional) || additional <= 0) { toast("Enter a valid amount", "error"); return; }

  const rs = reserves.find(r => r.asset.id === selectedAsset.id);
  const liveAsset = rs?.asset ?? selectedAsset;

  if (hfForLeverage(leverage, liveAsset.cFactor, rs?.lFactor ?? 1) < minHF()) {
    toast("HF too low \u2014 reduce leverage", "error"); return;
  }

  const additionalStroops = BigInt(Math.round(additional * 1e7));
  setLoading($("add-funds-btn") as HTMLButtonElement, true);
  showTxStepper(["Approve", "Submit"]);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, liveAsset.id, additionalStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${liveAsset.symbol}`, 0);
    const submitXdr = await buildOpenPositionXdr(selectedPool, userAddress, liveAsset, additionalStroops, leverage);
    await signAndSubmit(submitXdr, `Add ${fmt(additional, 2)} ${liveAsset.symbol} at ${leverage.toFixed(1)}\u00D7`, 1);
    hideTxStepper();
    // Update PnL entry: add to existing deposit
    const existingPnl = getPnlEntry(liveAsset.id, selectedPool.id);
    const newDeposit = (existingPnl?.deposit ?? 0) + additional;
    savePnlEntry(liveAsset.id, selectedPool.id, newDeposit);
    ($("add-funds-input") as HTMLInputElement).value = "";
    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    const msg: string = e?.message ?? "Transaction failed";
    if (msg.includes("#1205") || msg.includes("InvalidHf")) {
      toast("Health factor too low \u2014 reduce leverage.", "error");
    } else if (msg.includes("#1207") || msg.includes("InvalidUtilRate")) {
      toast("Pool utilization limit reached \u2014 not enough liquidity. Reduce leverage or deposit.", "error");
    } else {
      toast(msg.slice(0, 200), "error");
    }
  } finally {
    setLoading($("add-funds-btn") as HTMLButtonElement, false);
  }
}

/** Resupply: deposit entire wallet balance of the position asset as extra collateral. */
async function resupply() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
  if (bal <= 0) { toast(`No ${selectedAsset.symbol} in wallet to resupply`, "error"); return; }

  const amountStroops = BigInt(Math.round(bal * 1e7));
  setLoading($("resupply-btn") as HTMLButtonElement, true);
  showTxStepper(["Approve", "Resupply"]);
  try {
    const approveXdr = await buildApproveXdr(selectedPool, userAddress, selectedAsset.id, amountStroops + 1n);
    await signAndSubmit(approveXdr, `Approve ${selectedAsset.symbol}`, 0);

    const supplyXdr = await buildResupplyXdr(selectedPool, userAddress, selectedAsset.id, amountStroops);
    await signAndSubmit(supplyXdr, `Resupply ${fmt(bal, 4)} ${selectedAsset.symbol}`, 1);
    hideTxStepper();
    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    toast(e?.message ?? "Resupply failed", "error");
  } finally {
    setLoading($("resupply-btn") as HTMLButtonElement, false);
  }
}

/** Claim BLND from pool, then swap to the selected asset via Stellar DEX path payment. */
async function claimAndConvert() {
  if (!userAddress) return;
  if (demoMode) { toast("Demo mode \u2014 connect a real wallet to transact", "info"); return; }
  const pos = positions.byAsset.get(selectedAsset.id);
  if (!pos) return;

  // Step 1: Claim BLND
  const tokenIds: number[] = [];
  for (const p of positions.byAsset.values()) {
    if (p.bTokens > 0n) tokenIds.push(p.asset.supplyTokenId);
    if (p.dTokens > 0n) tokenIds.push(p.asset.borrowTokenId);
  }
  if (tokenIds.length === 0) { toast("No positions to claim from", "error"); return; }

  setLoading($("compound-btn") as HTMLButtonElement, true);
  showTxStepper(["Claim BLND", "Swap"]);
  try {
    // Claim
    const claimXdr = await buildClaimXdr(selectedPool, userAddress, tokenIds);
    await signAndSubmit(claimXdr, "Claim BLND", 0);

    // Check actual BLND balance after claim
    const blndBalance = await fetchAssetBalance(userAddress, getBlndId());
    if (blndBalance <= 0) { toast("No BLND to convert", "error"); hideTxStepper(1000); await loadAll(); return; }

    // Step 2: Swap BLND -> position asset via DEX path payment (classic tx)
    updateTxStep(1, "active");
    toast(`Swapping ${fmt(blndBalance, 2)} BLND \u2192 ${selectedAsset.symbol}\u2026`, "info");
    const { xdr: swapXdr, estimate } = await buildSwapBlndXdr(
      userAddress,
      blndBalance,
      selectedAsset.id,
      swapSlippage,
    );
    // Sign via wallet kit
    toast(`Sign swap in your wallet\u2026`, "info");
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(swapXdr, {
      networkPassphrase: getNetworkPassphrase(),
      address: userAddress!,
    });
    toast(`Submitting swap\u2026`, "info");
    const swapHash = await submitClassicXdr(signedTxXdr);
    updateTxStep(1, "done");
    toast(`Converted ${fmt(blndBalance, 2)} BLND \u2192 ~${estimate} ${selectedAsset.symbol}`, "success");
    addTxToHistory(`Swap BLND \u2192 ${selectedAsset.symbol}`, swapHash, "success");
    hideTxStepper();

    await loadAll();
  } catch (e: any) {
    markStepperError(2);
    toast(e?.message ?? "Claim & Convert failed", "error");
  } finally {
    setLoading($("compound-btn") as HTMLButtonElement, false);
  }
}

function setLoading(btn: HTMLButtonElement, on: boolean) {
  btn.disabled = on;
  btn.classList.toggle("btn-loading", on);
}

// ── Wallet connect / switch / disconnect ──────────────────────────────────────

function showConnected() {
  $("wallet-address").textContent = fmtAddr(userAddress!);
  $("connect-btn").classList.add("hidden");
  $("wallet-connected").classList.remove("hidden");
  $("connect-prompt").classList.add("hidden");
  if (activeView === "leverage") {
    $("dashboard").classList.remove("hidden");
    $("asset-tabs-bar").style.display = "";
  }
}

async function connect() {
  try {
    const result = await StellarWalletsKit.authModal({ network: getActiveNetwork() === "testnet" ? Networks.TESTNET : Networks.PUBLIC });
    // Verify wallet network matches app network
    const networkOk = await verifyWalletNetwork();
    if (!networkOk) {
      await StellarWalletsKit.disconnect();
      return;
    }
    userAddress  = result.address;
    localStorage.setItem("walletAddress", userAddress);
    showConnected();
    buildPoolTabs();
    buildAssetTabs();
    renderPoolFooter();
    await loadAll();
  } catch (e: any) {
    if (e?.message !== "User closed the modal") toast("Failed to connect wallet", "error");
  }
}

/** Re-open wallet modal to switch to a different account without a full page reload. */
async function switchWallet() {
  try {
    const result = await StellarWalletsKit.authModal({ network: getActiveNetwork() === "testnet" ? Networks.TESTNET : Networks.PUBLIC });
    if (result.address === userAddress) return;
    // Verify wallet network matches app network
    const networkOk = await verifyWalletNetwork();
    if (!networkOk) return;
    userAddress = result.address;
    localStorage.setItem("walletAddress", userAddress);
    $("wallet-address").textContent = fmtAddr(userAddress);
    reserves  = [];
    positions = { byAsset: new Map() };
    await loadAll();
    toast("Switched wallet", "success");
  } catch (e: any) {
    if (e?.message !== "User closed the modal") toast("Failed to switch wallet", "error");
  }
}

async function disconnect() {
  await StellarWalletsKit.disconnect();
  userAddress = null;
  localStorage.removeItem("walletAddress");
  reserves    = [];
  positions   = { byAsset: new Map() };
  $("connect-btn").classList.remove("hidden");
  $("wallet-connected").classList.add("hidden");
  $("connect-prompt").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
  $("asset-tabs-bar").style.display = "none";
}

// ── View switching (Leverage / Swap) ─────────────────────────────────────

function switchView(view: AppView) {
  activeView = view;
  // Top nav active states
  const overviewBtn = $("proto-overview");
  const blendBtn = $("proto-blend");
  const swapBtn  = $("proto-swap");
  const vaultBtn = $("proto-vault");
  overviewBtn.classList.toggle("active", view === "overview");
  blendBtn.classList.toggle("active", view === "leverage");
  swapBtn.classList.toggle("active", view === "swap");
  vaultBtn.classList.toggle("active", view === "vault");

  // Mobile sidebar active states
  document.getElementById("mobile-proto-overview")?.classList.toggle("active", view === "overview");
  document.getElementById("mobile-proto-blend")?.classList.toggle("active", view === "leverage");
  document.getElementById("mobile-proto-swap")?.classList.toggle("active", view === "swap");
  document.getElementById("mobile-proto-vault")?.classList.toggle("active", view === "vault");

  // Toggle pool tabs visibility (mobile sidebar)
  $("pool-tabs").style.display = view === "leverage" ? "" : "none";

  // Toggle asset tabs bar visibility
  const assetTabsBar = $("asset-tabs-bar");
  assetTabsBar.style.display = (view === "leverage" && userAddress) ? "" : "none";

  // Hide all views first
  $("overview-view").classList.add("hidden");
  $("swap-view").classList.add("hidden");
  $("vault-view").classList.add("hidden");
  $("dashboard").classList.add("hidden");
  $("connect-prompt").classList.add("hidden");

  if (view === "overview") {
    if (userAddress) {
      $("overview-view").classList.remove("hidden");
      loadOverview();
    } else {
      $("connect-prompt").classList.remove("hidden");
    }
  } else if (view === "leverage") {
    if (userAddress) {
      $("dashboard").classList.remove("hidden");
      assetTabsBar.style.display = "";
    } else {
      $("connect-prompt").classList.remove("hidden");
    }
  } else if (view === "swap") {
    $("swap-view").classList.remove("hidden");
    populateSwapAssets();
    updateSwapBtn();
  } else if (view === "vault") {
    $("vault-view").classList.remove("hidden");
    refreshVaultView();
  }
  closeDrawer();
  // Close pool dropdown
  $("pool-dropdown").classList.add("hidden");
}

// ── Mobile sidebar drawer (#5) ───────────────────────────────────────────

function closeDrawer() {
  document.querySelector(".sidebar")!.classList.remove("open");
  $("sidebar-backdrop").classList.add("hidden");
}

// ── Swap assets ──────────────────────────────────────────────────────────

// Swap assets use classic Stellar CODE-ISSUER format (not Soroban contract addresses)
const SWAP_ASSETS: { symbol: string; brokerId: string }[] = [
  { symbol: "XLM",     brokerId: "XLM" },
  { symbol: "USDC",    brokerId: "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { symbol: "EURC",    brokerId: "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  { symbol: "AQUA",    brokerId: "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "BLND",    brokerId: "BLND-GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY" },
  { symbol: "yXLM",    brokerId: "yXLM-GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55" },
  { symbol: "USDGLO",  brokerId: "USDGLO-GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV" },
];

function getSwapAssetList(): { symbol: string; brokerId: string }[] {
  const seen = new Set(SWAP_ASSETS.map(a => a.symbol));
  const list = [...SWAP_ASSETS];
  return list;
}

function populateSwapAssets() {
  const sellSelect = $("swap-sell-asset") as HTMLSelectElement;
  const buySelect  = $("swap-buy-asset") as HTMLSelectElement;
  if (sellSelect.options.length > 0) return; // already populated

  const list = getSwapAssetList();
  list.forEach(a => {
    sellSelect.add(new Option(a.symbol, a.brokerId));
    buySelect.add(new Option(a.symbol, a.brokerId));
  });
  // Defaults: sell XLM, buy USDC
  sellSelect.value = "XLM";
  const usdcAsset = list.find(a => a.symbol === "USDC");
  if (usdcAsset) {
    buySelect.value = usdcAsset.brokerId;
  } else {
    buySelect.selectedIndex = 1;
  }
}

let _quoteTimer: ReturnType<typeof setTimeout> | null = null;
let _lastQuote: any = null;
let swapSlippage = 0.02;

async function fetchSwapQuote() {
  const sellAmount = ($("swap-sell-amount") as HTMLInputElement).value;
  const sellAsset  = ($("swap-sell-asset") as HTMLSelectElement).value;
  const buyAsset   = ($("swap-buy-asset") as HTMLSelectElement).value;

  if (!sellAmount || parseFloat(sellAmount) <= 0 || sellAsset === buyAsset) {
    $("swap-quote-details").classList.add("hidden");
    ($("swap-buy-amount") as HTMLInputElement).value = "";
    _lastQuote = null;
    updateSwapBtn();
    return;
  }

  try {
    const quote = await estimateSwap({
      sellingAsset: sellAsset,
      buyingAsset: buyAsset,
      sellingAmount: sellAmount,
      slippageTolerance: swapSlippage,
    });

    _lastQuote = quote;

    if (quote.status === "success" && quote.estimatedBuyingAmount) {
      ($("swap-buy-amount") as HTMLInputElement).placeholder = "\u2014";
      ($("swap-buy-amount") as HTMLInputElement).value = parseFloat(quote.estimatedBuyingAmount).toFixed(7);

      const sellNum = parseFloat(sellAmount);
      const buyNum  = parseFloat(quote.estimatedBuyingAmount);
      const sellSym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
      const buySym  = ($("swap-buy-asset") as HTMLSelectElement).selectedOptions[0].text;

      $("swap-rate").textContent = `1 ${sellSym} \u2248 ${(buyNum / sellNum).toFixed(6)} ${buySym}`;
      $("swap-direct").textContent = quote.directTrade
        ? `${parseFloat(quote.directTrade.buying).toFixed(7)} ${buySym}`
        : "\u2014";
      $("swap-profit").textContent = quote.profit ? `${quote.profit}` : "\u2014";
      $("swap-quote-details").classList.remove("hidden");
    } else {
      ($("swap-buy-amount") as HTMLInputElement).value = quote.status === "unfeasible" ? "No route" : "\u2014";
      $("swap-quote-details").classList.add("hidden");
      _lastQuote = null;
    }
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    ($("swap-buy-amount") as HTMLInputElement).value = "";
    ($("swap-buy-amount") as HTMLInputElement).placeholder = "Quote unavailable";
    $("swap-quote-details").classList.add("hidden");
    _lastQuote = null;
    console.warn("Swap quote:", errMsg);
  }
  updateSwapBtn();
}

function updateSwapBtn() {
  const btn = $("swap-btn") as HTMLButtonElement;
  const sellAmount = ($("swap-sell-amount") as HTMLInputElement).value;
  const hasAmount = sellAmount && parseFloat(sellAmount) > 0;
  const sellAsset = ($("swap-sell-asset") as HTMLSelectElement).value;
  const buyAsset  = ($("swap-buy-asset") as HTMLSelectElement).value;
  const samePair = sellAsset === buyAsset;

  if (!userAddress) {
    btn.textContent = "Connect Wallet";
    btn.disabled = true;
  } else if (samePair) {
    btn.textContent = "Select different assets";
    btn.disabled = true;
  } else if (!hasAmount) {
    btn.textContent = "Enter amount";
    btn.disabled = true;
  } else if (_lastQuote && _lastQuote.status === "success") {
    btn.textContent = "Swap (coming soon)";
    btn.disabled = true; // Execution will be enabled in a future update
  } else {
    btn.textContent = "Get Quote";
    btn.disabled = true;
  }
}

function debounceQuote() {
  if (_quoteTimer) clearTimeout(_quoteTimer);
  _quoteTimer = setTimeout(fetchSwapQuote, 500);
}

// ── Tooltip popovers (#1) ────────────────────────────────────────────────────

function initTooltips() {
  const popover = $("tooltip-popover");
  function showTip(el: HTMLElement) {
    popover.textContent = el.dataset.tip || "";
    const rect = el.getBoundingClientRect();
    popover.style.left = `${rect.left + rect.width / 2}px`;
    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.transform = "translateX(-50%)";
  }
  document.querySelectorAll<HTMLElement>(".tooltip").forEach(el => {
    if (el.hasAttribute("title")) {
      el.dataset.tip = el.getAttribute("title") || "";
      el.removeAttribute("title");
    }

    el.addEventListener("mouseenter", () => { showTip(el); popover.classList.add("visible"); });
    el.addEventListener("mouseleave", () => popover.classList.remove("visible"));
    // Mobile: toggle on click
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      showTip(el);
      popover.classList.toggle("visible");
    });
  });
  // Also handle data-tip on non-.tooltip elements (buttons, etc.)
  document.querySelectorAll<HTMLElement>("[data-tip]:not(.tooltip)").forEach(el => {
    el.removeAttribute("title");

    el.addEventListener("mouseenter", () => { showTip(el); popover.classList.add("visible"); });
    el.addEventListener("mouseleave", () => popover.classList.remove("visible"));
  });
  document.addEventListener("click", () => popover.classList.remove("visible"));
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Expert toggle (settings dropdown)
function toggleExpert() {
  expertMode = !expertMode;
  // Update settings dropdown badge
  const btn = $("expert-toggle");
  const badge = btn.querySelector(".settings-badge");
  if (badge) badge.textContent = expertMode ? "On" : "Off";
  btn.classList.toggle("expert-active", expertMode);
  // Update mobile sidebar toggle
  const mobileBtn = document.getElementById("mobile-expert-toggle");
  if (mobileBtn) {
    mobileBtn.classList.toggle("expert-active", expertMode);
    mobileBtn.textContent = expertMode ? "Expert ON" : "Expert";
  }
  renderSelectedAsset();
  updatePreview();
}
$("expert-toggle").addEventListener("click", toggleExpert);
document.getElementById("mobile-expert-toggle")?.addEventListener("click", toggleExpert);

// Theme toggle (settings dropdown)
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") as Theme || getSystemTheme();
  const next: Theme = current === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
}
$("theme-toggle").addEventListener("click", toggleTheme);
document.getElementById("mobile-theme-toggle")?.addEventListener("click", toggleTheme);

// Settings dropdown toggle
$("settings-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("settings-dropdown").classList.toggle("hidden");
  $("pool-dropdown").classList.add("hidden");
});

// Network toggle
$("network-toggle").addEventListener("click", () => {
  const next: NetworkMode = getActiveNetwork() === "mainnet" ? "testnet" : "mainnet";
  switchNetwork(next);
});

// Fund testnet wallet
$("fund-testnet-btn").addEventListener("click", fundTestnetWallet);

// Protocol nav (desktop top nav)
$("proto-overview").addEventListener("click", () => switchView("overview"));
$("proto-blend").addEventListener("click", (e) => {
  e.stopPropagation();
  if (activeView === "leverage") {
    // Toggle pool dropdown
    $("pool-dropdown").classList.toggle("hidden");
    $("settings-dropdown").classList.add("hidden");
  } else {
    switchView("leverage");
  }
});
$("proto-swap").addEventListener("click",  () => switchView("swap"));
$("proto-vault").addEventListener("click", () => switchView("vault"));

// Mobile sidebar nav
document.getElementById("mobile-proto-overview")?.addEventListener("click", () => switchView("overview"));
document.getElementById("mobile-proto-blend")?.addEventListener("click", () => switchView("leverage"));
document.getElementById("mobile-proto-swap")?.addEventListener("click", () => switchView("swap"));
document.getElementById("mobile-proto-vault")?.addEventListener("click", () => switchView("vault"));

// Close dropdowns on click outside
document.addEventListener("click", () => {
  $("pool-dropdown").classList.add("hidden");
  $("settings-dropdown").classList.add("hidden");
});

// Mobile hamburger (#5)
$("hamburger-btn").addEventListener("click", () => {
  document.querySelector(".sidebar")!.classList.add("open");
  $("sidebar-backdrop").classList.remove("hidden");
});
$("sidebar-backdrop").addEventListener("click", closeDrawer);

// Mobile card tabs (#12) — note: order is swapped in new layout (action=left=0, position=right=1)
document.querySelectorAll<HTMLButtonElement>(".mobile-card-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mobile-card-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const panel = btn.dataset.panel;
    const cards = document.querySelectorAll<HTMLElement>(".two-col > .card");
    if (window.innerWidth <= 900) {
      cards[0]?.classList.toggle("mobile-hidden", panel !== "action");
      cards[1]?.classList.toggle("mobile-hidden", panel !== "position");
    }
  });
});

// Collapsible stats (#23)
$("stats-toggle").addEventListener("click", () => {
  $("stats-collapsible").classList.toggle("collapsed");
});

// Vault deposit/withdraw tabs
document.querySelectorAll<HTMLButtonElement>(".vault-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".vault-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const action = btn.dataset.vaultAction;
    $("vault-deposit-section").classList.toggle("hidden", action !== "deposit");
    $("vault-withdraw-section").classList.toggle("hidden", action !== "withdraw");
  });
});

// Slippage selector
document.querySelectorAll(".slippage-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".slippage-opt").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    (document.getElementById("slippage-custom-input") as HTMLInputElement).value = "";
    swapSlippage = parseFloat((btn as HTMLElement).dataset.slip!);
    debounceQuote();
  });
});
$("slippage-custom-input").addEventListener("input", () => {
  const val = parseFloat(($("slippage-custom-input") as HTMLInputElement).value);
  if (val > 0 && val <= 50) {
    document.querySelectorAll(".slippage-opt").forEach(b => b.classList.remove("active"));
    swapSlippage = val / 100;
    debounceQuote();
  }
});

// Swap events
$("swap-sell-amount").addEventListener("input", debounceQuote);
$("swap-sell-asset").addEventListener("change", () => { _lastQuote = null; debounceQuote(); updateSwapBalance(); });
$("swap-buy-asset").addEventListener("change",  () => { _lastQuote = null; debounceQuote(); });
$("swap-reverse").addEventListener("click", () => {
  const sell = $("swap-sell-asset") as HTMLSelectElement;
  const buy  = $("swap-buy-asset") as HTMLSelectElement;
  const tmp = sell.value;
  sell.value = buy.value;
  buy.value = tmp;
  _lastQuote = null;
  debounceQuote();
  updateSwapBalance();
});

// Map broker asset ID back to Soroban contract ID for balance lookups
const BROKER_TO_CONTRACT: Record<string, string> = {
  "XLM": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  "EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IBER": "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
  "AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA": "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
};

async function updateSwapBalance() {
  if (!userAddress) return;
  const sellBrokerId = ($("swap-sell-asset") as HTMLSelectElement).value;
  const contractId = BROKER_TO_CONTRACT[sellBrokerId];
  if (!contractId) { $("swap-sell-balance").textContent = "\u2014"; return; }
  try {
    const bal = await fetchAssetBalance(userAddress, contractId);
    const sym = ($("swap-sell-asset") as HTMLSelectElement).selectedOptions[0].text;
    $("swap-sell-balance").textContent = `${fmt(bal, 4)} ${sym}`;
  } catch { $("swap-sell-balance").textContent = "\u2014"; }
}

$("connect-btn").addEventListener("click",    connect);
$("switch-wallet-btn").addEventListener("click", switchWallet);
$("disconnect-btn").addEventListener("click", disconnect);
$("refresh-btn").addEventListener("click",    () => loadAll());
$("open-btn").addEventListener("click",       openPosition);
$("close-btn").addEventListener("click",      closePosition);
$("repay-btn").addEventListener("click",      repayDebt);
$("claim-btn").addEventListener("click",      claimBlnd);
$("max-btn").addEventListener("click",        maxDeposit);
$("compound-btn").addEventListener("click",   claimAndConvert);
$("resupply-btn").addEventListener("click",   resupply);
$("adjust-btn").addEventListener("click",    adjustLeverage);
$("add-funds-btn").addEventListener("click", addFundsToPosition);

// Adjust sub-tabs (Adjust Leverage / Add Funds)
document.querySelectorAll<HTMLButtonElement>(".adjust-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    switchAdjustSubTab(btn.dataset.adjust as "leverage" | "add-funds");
  });
});

// Add Funds input events
($("add-funds-input") as HTMLInputElement).addEventListener("input", () => {
  refreshAddFundsBalance();
  updatePreview();
});
$("add-funds-max-btn").addEventListener("click", async () => {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    ($("add-funds-input") as HTMLInputElement).value = String(Math.floor(bal * 1e7) / 1e7);
    updatePreview();
  } catch { /* ignore */ }
});

async function refreshAddFundsBalance() {
  if (!userAddress) return;
  try {
    const bal = await fetchAssetBalance(userAddress, selectedAsset.id);
    $("add-funds-balance").textContent = `${fmt(bal, 4)} ${selectedAsset.symbol}`;
  } catch { /* ignore */ }
}

($("leverage-slider") as HTMLInputElement).addEventListener("input",  updatePreview);
// Live preview while typing (no clamping so user can type multi-digit numbers like "10")
($("leverage-input")  as HTMLInputElement).addEventListener("input", () => {
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const slider = $("leverage-slider") as HTMLInputElement;
  const v = parseFloat(numIn.value);
  if (!isNaN(v) && v >= 1.0) {
    slider.value = v.toFixed(1);
    updatePreview();
  }
});
// Clamp on blur / Enter so the final value is within valid range
($("leverage-input")  as HTMLInputElement).addEventListener("change", () => {
  const numIn  = $("leverage-input")  as HTMLInputElement;
  const slider = $("leverage-slider") as HTMLInputElement;
  let v = parseFloat(numIn.value);
  if (isNaN(v)) v = 1.0;
  v = Math.min(parseFloat(slider.max), Math.max(1.0, Math.round(v * 10) / 10));
  numIn.value  = v.toFixed(1);
  slider.value = v.toFixed(1);
  updatePreview();
});
($("initial-input")   as HTMLInputElement).addEventListener("input",  () => { refreshTabData(); updatePreview(); });
($("initial-input")   as HTMLInputElement).addEventListener("change", () => { refreshTabData(); updatePreview(); });

// ── Demo mode (#17) ──────────────────────────────────────────────────────────

$("demo-btn").addEventListener("click", () => {
  demoMode = true;
  userAddress = "GDEMO000000000000000000000000000000000000000000000000000";
  showConnected();
  $("wallet-address").textContent = "Demo Mode";
  $("switch-wallet-btn").classList.add("hidden");
  // Load mock reserves and positions
  reserves = assets.map(a => ({
    asset: a, cFactor: a.cFactor, lFactor: 1, interestSupplyApr: 4.2, interestBorrowApr: 6.8,
    blndSupplyApr: 2.1, blndBorrowApr: 1.5, netSupplyApr: 6.3, netBorrowCost: 5.3,
    totalSupply: 1000000, totalBorrow: 650000, available: 350000, priceUsd: 1.0,
  }));
  positions = { byAsset: new Map() };
  // One sample position
  const sampleAsset = assets[0];
  positions.byAsset.set(sampleAsset.id, {
    asset: sampleAsset, collateral: 5000, debt: 3000, equity: 2000,
    leverage: 2.5, hf: 1.15, bTokens: 50000000000n, dTokens: 30000000000n,
  } as AssetPosition);
  buildPoolTabs();
  buildAssetTabs();
  renderPoolFooter();
  $("asset-balance").textContent = "10,000.0000 " + selectedAsset.symbol;
  $("pos-blnd").textContent = "125.3400 BLND";
  renderSelectedAsset();
  toast("Demo mode \u2014 explore the UI without a wallet", "info");
});

// Init preview with defaults
updatePreview();
renderTxHistory();
renderPoolFooter();
initTooltips();

// ── Overview (cross-protocol dashboard) ───────────────────────────────────────

interface OverviewBlendPosition {
  pool: PoolDef;
  asset: AssetInfo;
  pos: AssetPosition;
  reserves: ReserveStats[];
}

interface OverviewVaultPosition {
  vault: VaultConfig;
  userPos: UserVaultPosition;
  stats: VaultStats | null;
}

let _overviewLoading = false;

async function loadOverview() {
  if (!userAddress || _overviewLoading) return;
  _overviewLoading = true;

  const blendPositions: OverviewBlendPosition[] = [];
  const vaultPositions: OverviewVaultPosition[] = [];

  // Fetch all Blend pool positions in parallel
  const poolFetches = getKnownPools().map(async (pool) => {
    try {
      const poolAssets = getPoolAssets(pool);
      const res = await fetchAllReserves(pool, userAddress!);
      const pos = await fetchUserPositions(pool, userAddress!, res);
      for (const [assetId, assetPos] of pos.byAsset) {
        const asset = poolAssets.find(a => a.id === assetId);
        if (asset) {
          blendPositions.push({ pool, asset, pos: assetPos, reserves: res });
        }
      }
    } catch (e) {
      console.warn(`Overview: failed to load pool ${pool.name}`, e);
    }
  });

  // Fetch vault positions in parallel
  const vaultFetches = getVaults().map(async (vault) => {
    if (!vault.vaultId) return;
    try {
      const [stats, userPos] = await Promise.all([
        fetchVaultStats(vault),
        fetchUserVaultBalance(vault, userAddress!),
      ]);
      if (userPos && userPos.underlyingValue > 0) {
        vaultPositions.push({ vault, userPos, stats });
      }
    } catch (e) {
      console.warn(`Overview: failed to load vault ${vault.name}`, e);
    }
  });

  await Promise.all([...poolFetches, ...vaultFetches]);
  renderOverview(blendPositions, vaultPositions);
  _overviewLoading = false;
}

function renderOverview(blendPos: OverviewBlendPosition[], vaultPos: OverviewVaultPosition[]) {
  const container = $("ov-protocols");
  const emptyEl = $("ov-empty");
  const totalPositions = blendPos.length + vaultPos.length;

  // Aggregate totals (USD-denominated where possible)
  let totalEquity = 0;
  let totalDebt = 0;

  for (const bp of blendPos) {
    const rs = bp.reserves.find(r => r.asset.id === bp.asset.id);
    const price = rs?.priceUsd ?? 0;
    totalEquity += bp.pos.equity * price;
    totalDebt += bp.pos.debt * price;
  }
  for (const vp of vaultPos) {
    totalEquity += vp.userPos.underlyingValue; // USDC-denominated
  }

  $("ov-total-equity").textContent = totalEquity > 0 ? `$${fmt(totalEquity, 2)}` : "--";
  $("ov-total-debt").textContent = totalDebt > 0 ? `$${fmt(totalDebt, 2)}` : "--";
  $("ov-total-count").textContent = String(totalPositions);

  if (totalPositions === 0) {
    emptyEl.classList.remove("hidden");
    container.innerHTML = "";
    return;
  }
  emptyEl.classList.add("hidden");

  let html = "";

  // Blend positions as data table
  if (blendPos.length > 0) {
    html += `<div class="overview-protocol-section">
      <div class="overview-protocol-header">
        <span class="overview-protocol-dot overview-protocol-dot-blend"></span>
        Blend Protocol
      </div>
      <table class="overview-table">
        <thead><tr>
          <th>Asset</th><th>Pool</th><th class="text-right">Equity</th>
          <th class="text-right">Leverage</th><th class="text-right">HF</th>
          <th class="text-right">Net APY</th><th class="text-right">Debt</th>
        </tr></thead><tbody>`;

    for (const bp of blendPos) {
      const rs = bp.reserves.find(r => r.asset.id === bp.asset.id);
      const price = rs?.priceUsd ?? 0;
      const batchNetApr = rs ? rs.netSupplyApr * bp.pos.leverage - rs.netBorrowCost * (bp.pos.leverage - 1) : 0;
      const netApy = aprToApy(batchNetApr);
      const hfColor = bp.pos.hf > 1.1 ? "hf-ok" : bp.pos.hf > 1.03 ? "hf-warn" : "hf-bad";
      const pool = getKnownPools().find(p => p.id === bp.pool.id)!;
      const batchTip = `Approximate APY — Blend does not auto-compound. Actual net APR: ${fmt(batchNetApr, 2)}%`;

      html += `<tr data-nav-pool="${bp.pool.id}" data-nav-asset="${bp.asset.id}">
        <td class="text-label">${bp.asset.symbol}</td>
        <td style="color:var(--text-2);font-family:var(--sans)">${pool.name}</td>
        <td class="text-right">${fmt(bp.pos.equity, 2)} ${bp.asset.symbol}</td>
        <td class="text-right">${fmt(bp.pos.leverage, 1)}&times;</td>
        <td class="text-right ${hfColor}">${isFinite(bp.pos.hf) ? fmt(bp.pos.hf, 3) : "\u221E"}</td>
        <td class="text-right ${netApy > 0 ? "hf-ok" : "hf-bad"}" title="${batchTip}">${netApy >= 0 ? "+" : ""}${fmt(netApy, 2)}%</td>
        <td class="text-right">${fmt(bp.pos.debt, 2)} ${bp.asset.symbol}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Vault positions (keep as cards since there's usually only 1)
  if (vaultPos.length > 0) {
    html += `<div class="overview-protocol-section">
      <div class="overview-protocol-header">
        <span class="overview-protocol-dot overview-protocol-dot-vault"></span>
        DeFindex Vaults
      </div>
      <div class="overview-positions">`;

    for (const vp of vaultPos) {
      const hf = vp.stats ? formatHf(vp.stats.healthFactor) : { text: "--", cls: "" };
      html += `<div class="overview-vault-card" data-nav-vault="${vp.vault.vaultId}">
        <div class="overview-pos-card-top">
          <span class="overview-pos-card-symbol">${vp.vault.name}</span>
          <span class="overview-pos-card-pool">DeFindex</span>
        </div>
        <div class="overview-pos-card-grid">
          <div class="overview-pos-card-metric">
            <span class="overview-pos-card-label">Value</span>
            <span class="overview-pos-card-value">${formatUsd(vp.userPos.underlyingValue)}</span>
          </div>
          <div class="overview-pos-card-metric">
            <span class="overview-pos-card-label">Strategy HF</span>
            <span class="overview-pos-card-value ${hf.cls}">${hf.text}</span>
          </div>
        </div>
      </div>`;
    }
    html += `</div></div>`;
  }

  container.innerHTML = html;

  // Wire up click navigation for Blend table rows
  container.querySelectorAll<HTMLElement>("tr[data-nav-pool]").forEach(row => {
    row.addEventListener("click", () => {
      const poolId = row.dataset.navPool!;
      const assetId = row.dataset.navAsset!;
      const pool = getKnownPools().find(p => p.id === poolId);
      if (pool) {
        selectPool(pool);
        const asset = getPoolAssets(pool).find(a => a.id === assetId);
        if (asset) selectAsset(asset);
        switchView("leverage");
      }
    });
  });

  // Wire up click navigation for vault cards
  container.querySelectorAll<HTMLElement>(".overview-vault-card").forEach(card => {
    card.addEventListener("click", () => switchView("vault"));
  });
}

$("overview-refresh-btn").addEventListener("click", () => loadOverview());

// ── Vault view ───────────────────────────────────────────────────────────────

function getActiveVault(): VaultConfig {
  return getVaults()[0];
}

let _lastVaultStats: VaultStats | null = null;
let _userVaultBalance: number = 0;
let _userWalletBalance: number = 0;

async function refreshVaultView() {
  const vault = getActiveVault();
  const vaultDepBtn = $("vault-deposit-btn") as HTMLButtonElement;
  const vaultWdBtn  = $("vault-withdraw-btn") as HTMLButtonElement;
  const rebalBtn    = $("vault-rebalance-btn") as HTMLButtonElement;

  const connected = !!userAddress;
  const vaultReady = !!vault.vaultId;

  vaultDepBtn.disabled = !connected || !vaultReady;
  vaultWdBtn.disabled  = !connected || !vaultReady;

  // Update labels
  $("vault-title").textContent = vault.name;
  $("vault-asset-label").textContent = vault.assetSymbol;
  $("vault-deposit-suffix").textContent = vault.assetSymbol;
  $("vault-withdraw-label").textContent = vault.assetSymbol;
  $("vault-withdraw-suffix").textContent = vault.assetSymbol;
  $("vault-min-hf").textContent = vault.minHf.toFixed(2);
  $("vault-loops").textContent = String(vault.targetLoops);

  // Contract link
  const explorerBase = getActiveNetwork() === "testnet"
    ? "https://stellar.expert/explorer/testnet/contract/"
    : "https://stellar.expert/explorer/public/contract/";
  const linkEl = $("vault-contract-link") as HTMLAnchorElement;
  if (vaultReady) {
    linkEl.textContent = vault.vaultId.slice(0, 8) + "..." + vault.vaultId.slice(-4);
    linkEl.href = explorerBase + vault.vaultId;
  } else {
    linkEl.textContent = "Not deployed";
    linkEl.href = "#";
  }

  if (!vaultReady) {
    $("vault-tvl").textContent = "Not deployed";
    $("vault-share-price").textContent = "--";
    $("vault-apy").textContent = "--";
    $("vault-leverage").textContent = "--";
    $("vault-hf").textContent = "--";
    $("vault-strategy-pos").classList.add("hidden");
    $("vault-hf-bar-wrap").classList.add("hidden");
    return;
  }

  // Fetch pool reserves for APY calculation
  let poolReserves: ReserveStats[] | undefined;
  try {
    const pool = getKnownPools().find(p => p.id === vault.poolId);
    if (pool) {
      poolReserves = await fetchAllReserves(pool, userAddress ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
    }
  } catch { /* APY will show as -- */ }

  // Fetch vault stats
  const stats = await fetchVaultStats(vault, poolReserves);
  _lastVaultStats = stats;

  if (stats) {
    $("vault-tvl").textContent = formatUsd(stats.totalEquity);
    $("vault-share-price").textContent = formatUsd(stats.sharePrice, 6);

    // Net APY (stats.netApy is actually APR — convert for display)
    const apyEl = $("vault-apy");
    if (stats.netApy !== null) {
      const vaultApy = aprToApy(stats.netApy);
      apyEl.textContent = (vaultApy >= 0 ? "+" : "") + vaultApy.toFixed(2) + "%";
      apyEl.className = "stat-value mono " + (vaultApy > 0 ? "hf-ok" : "hf-bad");
      const vaultTip = $("vault-apy-tip");
      if (vaultTip) vaultTip.setAttribute("data-tip",
        `Approximate APY — Blend interest does not auto-compound. Actual net APR: ${fmt(stats.netApy, 2)}%`);
    } else {
      apyEl.textContent = "--";
      apyEl.className = "stat-value mono";
    }

    // Leverage
    $("vault-leverage").textContent = stats.leverage.toFixed(2) + "\u00d7";

    // HF
    const hf = formatHf(stats.healthFactor);
    const hfEl = $("vault-hf");
    hfEl.textContent = hf.text;
    hfEl.className = "stat-value " + hf.cls;

    // Strategy position breakdown
    $("vault-strategy-pos").classList.remove("hidden");
    $("vault-collateral").textContent = fmt(stats.collateralValue, 2) + " " + vault.assetSymbol;
    $("vault-debt").textContent = fmt(stats.debtValue, 2) + " " + vault.assetSymbol;
    $("vault-equity").textContent = fmt(stats.totalEquity, 2) + " " + vault.assetSymbol;

    if (stats.supplyApr !== null) {
      $("vault-supply-apr").textContent = "+" + aprToApy(stats.supplyApr).toFixed(2) + "%";
      $("vault-supply-apr").className = "metric-value mono hf-ok";
    }
    if (stats.borrowApr !== null) {
      $("vault-borrow-apr").textContent = "-" + aprToApy(stats.borrowApr).toFixed(2) + "%";
      $("vault-borrow-apr").className = "metric-value mono hf-bad";
    }

    // HF bar visualization
    $("vault-hf-bar-wrap").classList.remove("hidden");
    const hfVal = isFinite(stats.healthFactor) ? stats.healthFactor : 3;
    const hfPct = Math.min(Math.max((hfVal - 1) / 1.0 * 100, 0), 100); // 1.0 to 2.0 range
    const fillEl = $("vault-hf-bar-fill") as HTMLElement;
    const markerEl = $("vault-hf-bar-marker") as HTMLElement;
    fillEl.style.width = hfPct + "%";
    fillEl.className = "hf-bar-fill " + (hfVal >= 1.1 ? (hfVal >= 1.5 ? "hf-fill-ok" : "hf-fill-warn") : "hf-fill-bad");
    markerEl.style.left = hfPct + "%";
    $("vault-hf-bar-label").textContent = isFinite(stats.healthFactor) ? stats.healthFactor.toFixed(3) : "\u221e";

    // Rebalance button — enabled only when HF < min_hf
    const needsRebalance = isFinite(stats.healthFactor) && stats.healthFactor < vault.minHf;
    rebalBtn.disabled = !connected || !needsRebalance;
    const hintEl = $("vault-rebalance-hint");
    if (needsRebalance) {
      hintEl.textContent = "HF below minimum — rebalance available";
      hintEl.className = "vault-rebalance-hint hf-bad";
    } else {
      hintEl.textContent = "HF is healthy";
      hintEl.className = "vault-rebalance-hint hf-ok";
    }
  }

  // Fetch user position if connected
  if (connected && userAddress) {
    // Wallet token balance (use defindex invokeRead which works reliably)
    try {
      const bal = await fetchTokenBalance(vault.assetId, userAddress, vault.decimals);
      _userWalletBalance = bal;
      $("vault-wallet-balance").textContent =
        bal.toFixed(2) + " " + vault.assetSymbol;
      if (bal === 0 && getActiveNetwork() === "testnet") {
        $("vault-wallet-balance").textContent += " (use Fund Wallet above)";
      }
    } catch (err) {
      console.warn("Vault wallet balance fetch failed:", err);
      _userWalletBalance = 0;
      $("vault-wallet-balance").textContent = "-- " + vault.assetSymbol;
    }

    // Vault position (equity deposited in strategy)
    const pos = await fetchUserVaultBalance(vault, userAddress);
    if (pos && pos.underlyingValue > 0) {
      _userVaultBalance = pos.underlyingValue;
      $("vault-user-pos").classList.remove("hidden");
      $("vault-user-value").textContent = formatUsd(pos.underlyingValue);
      $("vault-withdraw-balance").textContent = pos.underlyingValue.toFixed(4) + " " + vault.assetSymbol;
      // Share of vault
      if (stats && stats.totalEquity > 0) {
        const pct = (pos.underlyingValue / stats.totalEquity) * 100;
        $("vault-user-share-pct").textContent = pct.toFixed(1) + "%";
      } else {
        $("vault-user-share-pct").textContent = "--";
      }
    } else {
      _userVaultBalance = 0;
      $("vault-user-pos").classList.add("hidden");
    }
  }
}

// Vault deposit max — use cached wallet balance
$("vault-deposit-max").addEventListener("click", () => {
  if (_userWalletBalance > 0) {
    ($("vault-deposit-input") as HTMLInputElement).value = _userWalletBalance.toFixed(2);
  }
});

// Vault withdraw max — use vault balance with small buffer for rounding
$("vault-withdraw-max").addEventListener("click", () => {
  if (_userVaultBalance > 0) {
    // Subtract tiny buffer (0.001) to avoid InsufficientBalance from rounding
    const safe = Math.max(_userVaultBalance - 0.001, 0);
    ($("vault-withdraw-input") as HTMLInputElement).value = safe > 0 ? safe.toFixed(4) : "";
  }
});

// Vault deposit
$("vault-deposit-btn").addEventListener("click", async () => {
  const vault = getActiveVault();
  if (!userAddress || !vault.vaultId) return;
  const amount = parseFloat(($("vault-deposit-input") as HTMLInputElement).value);
  if (!amount || amount <= 0) return;

  try {
    ($("vault-deposit-btn") as HTMLButtonElement).disabled = true;
    ($("vault-deposit-btn") as HTMLButtonElement).textContent = "Depositing...";

    const xdr = await buildVaultDepositXdr(vault, userAddress, amount);
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr);
    await submitSignedXdr(signedTxXdr);
    await refreshVaultView();
    ($("vault-deposit-input") as HTMLInputElement).value = "";
  } catch (err: any) {
    alert("Deposit failed: " + (err.message || err));
  } finally {
    ($("vault-deposit-btn") as HTMLButtonElement).disabled = false;
    ($("vault-deposit-btn") as HTMLButtonElement).textContent = "Deposit";
  }
});

// Vault withdraw
$("vault-withdraw-btn").addEventListener("click", async () => {
  const vault = getActiveVault();
  if (!userAddress || !vault.vaultId) return;
  let amount = parseFloat(($("vault-withdraw-input") as HTMLInputElement).value);
  if (!amount || amount <= 0) return;

  // Cap at vault balance to prevent InsufficientBalance errors from rounding
  if (_userVaultBalance > 0 && amount >= _userVaultBalance) {
    amount = Math.max(_userVaultBalance - 0.001, 0.001);
  }

  try {
    ($("vault-withdraw-btn") as HTMLButtonElement).disabled = true;
    ($("vault-withdraw-btn") as HTMLButtonElement).textContent = "Withdrawing...";

    const xdr = await buildVaultWithdrawXdr(vault, userAddress, amount);
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr);
    await submitSignedXdr(signedTxXdr);
    await refreshVaultView();
    ($("vault-withdraw-input") as HTMLInputElement).value = "";
  } catch (err: any) {
    alert("Withdraw failed: " + (err.message || err));
  } finally {
    ($("vault-withdraw-btn") as HTMLButtonElement).disabled = false;
    ($("vault-withdraw-btn") as HTMLButtonElement).textContent = "Withdraw";
  }
});

// Vault rebalance
$("vault-rebalance-btn").addEventListener("click", async () => {
  const vault = getActiveVault();
  if (!userAddress || !vault.vaultId) return;

  try {
    ($("vault-rebalance-btn") as HTMLButtonElement).disabled = true;
    ($("vault-rebalance-btn") as HTMLButtonElement).textContent = "Rebalancing...";

    const xdr = await buildVaultRebalanceXdr(vault, userAddress);
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr);
    await submitSignedXdr(signedTxXdr);
    await refreshVaultView();
  } catch (err: any) {
    alert("Rebalance failed: " + (err.message || err));
  } finally {
    ($("vault-rebalance-btn") as HTMLButtonElement).disabled = false;
    ($("vault-rebalance-btn") as HTMLButtonElement).textContent = "Rebalance";
  }
});

// ── Auto-reconnect saved wallet ──────────────────────────────────────────────
(async () => {
  // Restore network preference
  const savedNet = localStorage.getItem("networkMode") as NetworkMode | null;
  if (savedNet === "testnet") {
    setNetwork("testnet");
    StellarWalletsKit.init({
      modules: [new FreighterModule(), new xBullModule(), new AlbedoModule(), new LobstrModule(), new HanaModule()],
      network: Networks.TESTNET,
    });
    selectedPool = getKnownPools()[0];
    assets = getPoolAssets(selectedPool);
    selectedAsset = assets[0];
    $("network-toggle").textContent = "Testnet";
    $("network-toggle").classList.add("testnet-active");
    $("testnet-banner").classList.remove("hidden");
  }

  const saved = localStorage.getItem("walletAddress");
  if (!saved) return;
  userAddress = saved;
  showConnected();
  buildPoolTabs();
  buildAssetTabs();
  renderPoolFooter();
  await loadAll();
})();

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  // Ignore shortcuts when typing in inputs
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  // R = refresh
  if (e.key === "r" || e.key === "R") {
    if (activeView === "leverage" && userAddress) loadAll();
    else if (activeView === "overview" && userAddress) loadOverview();
    else if (activeView === "vault") refreshVaultView();
  }
  // Escape = close modals/dropdowns
  if (e.key === "Escape") {
    $("pool-dropdown").classList.add("hidden");
    $("settings-dropdown").classList.add("hidden");
    $("alert-modal-overlay").classList.add("hidden");
    closeDrawer();
  }
});

// ── APY Alert subscription ──────────────────────────────────────────────────

const ALERTS_WORKER_URL = "https://turbolong-alerts.workers.dev";

$("alert-bell-btn").addEventListener("click", () => {
  $("alert-pool-name").textContent = selectedPool.name;
  $("alert-asset-name").textContent = selectedAsset.symbol;

  // Pre-select the closest leverage bracket to current slider value
  const curLev = parseFloat(($("leverage-slider") as HTMLInputElement).value) || 5;
  const brackets = [2, 3, 5, 8, 10];
  const closest = brackets.reduce((a, b) => Math.abs(b - curLev) < Math.abs(a - curLev) ? b : a);
  ($("alert-leverage") as HTMLSelectElement).value = String(closest);

  $("alert-modal-overlay").classList.remove("hidden");
});

$("alert-modal-close").addEventListener("click", () => {
  $("alert-modal-overlay").classList.add("hidden");
});

$("alert-modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("alert-modal-overlay")) {
    $("alert-modal-overlay").classList.add("hidden");
  }
});

$("alert-subscribe-btn").addEventListener("click", async () => {
  const email = ($("alert-email") as HTMLInputElement).value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("Please enter a valid email address.", "error");
    return;
  }

  const leverageBracket = Number(($("alert-leverage") as HTMLSelectElement).value);
  const btn = $("alert-subscribe-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Subscribing...";

  try {
    const res = await fetch(`${ALERTS_WORKER_URL}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        pool_id: selectedPool.id,
        asset_symbol: selectedAsset.symbol,
        leverage_bracket: leverageBracket,
      }),
    });

    const data = await res.json() as any;

    if (data.ok) {
      toast("Check your email to verify your alert subscription.", "success");
      $("alert-modal-overlay").classList.add("hidden");
      ($("alert-email") as HTMLInputElement).value = "";
    } else {
      toast(data.error || "Subscription failed.", "error");
    }
  } catch (e: any) {
    toast(`Subscription failed: ${e.message?.slice(0, 100)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Subscribe";
  }
});
