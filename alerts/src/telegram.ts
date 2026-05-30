/**
 * Telegram bot for TurbolongAlertsBot.
 *
 * Commands:
 *   /subscribe hf <pool> <asset> <leverage>  — subscribe to negative-APY alerts
 *   /positions                               — list your verified subscriptions
 *   /rates                                   — current supply/borrow APY for all pools
 *
 * Webhook: POST /telegram  (registered via setWebhook)
 */

import { POOLS, LEVERAGE_BRACKETS, fetchReserveRates, computeNetApy } from "./stellar.ts";

export interface TelegramEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  FRONTEND_ORIGIN: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number };
  text?: string;
}

// ── Telegram API helpers ──────────────────────────────────────────────────────

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

// ── Command handlers ──────────────────────────────────────────────────────────

/**
 * /subscribe hf <pool_name_or_id> <asset_symbol> <leverage>
 *
 * Creates a subscription tied to the Telegram chat ID (no email needed).
 * Subscriptions are immediately "verified" since the user is already authenticated
 * via Telegram.
 */
async function handleSubscribe(
  env: TelegramEnv,
  chatId: number,
  args: string[],
): Promise<string> {
  // args: ["hf", "<pool>", "<asset>", "<leverage>"]
  if (args[0] !== "hf") {
    return "Usage: /subscribe hf &lt;pool&gt; &lt;asset&gt; &lt;leverage&gt;\n\nExample:\n<code>/subscribe hf Etherfuse CETES 5</code>";
  }

  const [, poolArg, assetArg, levArg] = args;
  if (!poolArg || !assetArg || !levArg) {
    return "Usage: /subscribe hf &lt;pool&gt; &lt;asset&gt; &lt;leverage&gt;\n\nExample:\n<code>/subscribe hf Etherfuse CETES 5</code>";
  }

  // Resolve pool
  const pool = POOLS.find(
    p => p.name.toLowerCase() === poolArg.toLowerCase() || p.id === poolArg,
  );
  if (!pool) {
    const names = POOLS.map(p => p.name).join(", ");
    return `Unknown pool "<b>${poolArg}</b>". Available: ${names}`;
  }

  // Resolve asset
  const asset = pool.assets.find(
    a => a.symbol.toLowerCase() === assetArg.toLowerCase(),
  );
  if (!asset) {
    const syms = pool.assets.map(a => a.symbol).join(", ");
    return `Unknown asset "<b>${assetArg}</b>" in ${pool.name}. Available: ${syms}`;
  }

  // Validate leverage
  const lev = Number(levArg);
  if (!LEVERAGE_BRACKETS.includes(lev)) {
    return `Invalid leverage. Must be one of: ${LEVERAGE_BRACKETS.join(", ")}`;
  }

  // Upsert subscription (telegram_chat_id column, verified=1 immediately)
  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token, verified, telegram_chat_id)
      VALUES (?1, ?2, ?3, ?4, NULL, NULL, 1, ?5)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET verified = 1, telegram_chat_id = ?5
    `).bind(
      `tg:${chatId}`,
      pool.id,
      asset.symbol,
      lev,
      chatId,
    ).run();
  } catch (e: any) {
    console.error("DB upsert failed:", e);
    return "Database error — please try again later.";
  }

  return `✅ Subscribed! You'll receive an alert when <b>${asset.symbol}</b> at <b>${lev}×</b> on <b>${pool.name}</b> turns negative-APY.`;
}

/**
 * /positions — list all active subscriptions for this chat.
 */
async function handlePositions(env: TelegramEnv, chatId: number): Promise<string> {
  const rows = await env.DB.prepare(`
    SELECT pool_id, asset_symbol, leverage_bracket
    FROM subscriptions
    WHERE telegram_chat_id = ?1 AND verified = 1
    ORDER BY pool_id, asset_symbol, leverage_bracket
  `).bind(chatId).all();

  if (!rows.results?.length) {
    return "No active subscriptions. Use /subscribe hf &lt;pool&gt; &lt;asset&gt; &lt;leverage&gt; to add one.";
  }

  const poolNames: Record<string, string> = {};
  for (const p of POOLS) poolNames[p.id] = p.name;

  const lines = rows.results.map(r => {
    const name = poolNames[r.pool_id as string] ?? (r.pool_id as string).slice(0, 8) + "…";
    return `• <b>${r.asset_symbol}</b> @ ${r.leverage_bracket}× on ${name}`;
  });

  return `<b>Your subscriptions:</b>\n${lines.join("\n")}\n\nYou'll be alerted when net APY turns negative.`;
}

/**
 * /rates — fetch live supply/borrow APY for all pools and assets.
 */
async function handleRates(): Promise<string> {
  const lines: string[] = ["<b>Current rates (net APY):</b>\n"];

  for (const pool of POOLS) {
    lines.push(`<b>${pool.name}</b>`);
    for (const asset of pool.assets) {
      try {
        const rates = await fetchReserveRates(pool, asset);
        if (!rates) { lines.push(`  ${asset.symbol}: unavailable`); continue; }
        const supplyApy = ((Math.exp(rates.netSupplyApr / 100) - 1) * 100).toFixed(2);
        const borrowApy = ((Math.exp(rates.netBorrowCost / 100) - 1) * 100).toFixed(2);
        const net5x = computeNetApy(rates, 5).toFixed(2);
        const net10x = computeNetApy(rates, 10).toFixed(2);
        lines.push(
          `  <code>${asset.symbol.padEnd(8)}</code> supply <b>${supplyApy}%</b>  borrow <b>${borrowApy}%</b>  5× <b>${net5x}%</b>  10× <b>${net10x}%</b>`,
        );
      } catch {
        lines.push(`  ${asset.symbol}: fetch error`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function handleTelegramUpdate(
  update: TgUpdate,
  env: TelegramEnv,
): Promise<void> {
  const msg = update.message;
  if (!msg?.text || !msg.chat) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Strip bot username suffix (e.g. /start@TurbolongAlertsBot)
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();

  let reply: string;
  switch (cmd) {
    case "/subscribe":
      reply = await handleSubscribe(env, chatId, args);
      break;
    case "/positions":
      reply = await handlePositions(env, chatId);
      break;
    case "/rates":
      reply = await handleRates();
      break;
    case "/start":
    case "/help":
      reply = [
        "<b>TurbolongAlertsBot</b>",
        "",
        "Get alerted when your leveraged position's net APY turns negative.",
        "",
        "<b>Commands:</b>",
        "/subscribe hf &lt;pool&gt; &lt;asset&gt; &lt;leverage&gt;",
        "  Subscribe to negative-APY alerts.",
        "  Example: <code>/subscribe hf Etherfuse CETES 5</code>",
        "",
        "/positions — list your active subscriptions",
        "/rates     — live supply/borrow APY for all pools",
        "",
        `<b>Pools:</b> ${POOLS.map(p => p.name).join(", ")}`,
        `<b>Leverage brackets:</b> ${LEVERAGE_BRACKETS.join(", ")}`,
      ].join("\n");
      break;
    default:
      return; // ignore unknown commands / plain messages
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
}

/**
 * Send a Telegram alert to a subscriber when net APY turns negative.
 * Called from the cron handler in index.ts.
 */
export async function sendTelegramAlert(
  token: string,
  chatId: number,
  opts: {
    poolName: string;
    assetSymbol: string;
    leverage: number;
    netApy: number;
    supplyApr: number;
    borrowCost: number;
  },
): Promise<void> {
  const text = [
    `⚠️ <b>Negative APY Alert</b>`,
    ``,
    `<b>${opts.assetSymbol}</b> at <b>${opts.leverage}×</b> on <b>${opts.poolName}</b>`,
    `Net APY: <b>${opts.netApy.toFixed(2)}%</b>`,
    `Supply: ${opts.supplyApr.toFixed(2)}%  Borrow cost: ${opts.borrowCost.toFixed(2)}%`,
    ``,
    `Consider reducing leverage or closing your position.`,
  ].join("\n");

  await sendMessage(token, chatId, text);
}
