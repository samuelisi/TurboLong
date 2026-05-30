# Turbolong APY Alerts Bot

A serverless Telegram bot + email notification system that monitors Blend Finance leveraged lending positions and alerts users when net APY turns negative.

## Features

- **Telegram Bot** with commands:
  - `/subscribe hf <pool> <asset> <leverage>` — subscribe to negative-APY alerts for a specific position
  - `/positions` — list all your active subscriptions
  - `/rates` — view live supply/borrow APY for all pools and leverage brackets
  - `/start` and `/help` — command documentation

- **Email Subscriptions** with verification flow:
  - Email-based subscription with verification link
  - Automatic unsubscribe links in alert emails

- **Automated Alerts**:
  - Every 15 minutes, checks if any position's net APY has turned negative
  - Rate-limited to max 1 alert per subscription per 24 hours
  - Sends alerts via email and/or Telegram

- **Multi-Pool Support**:
  - Etherfuse, Fixed, YieldBlox (extensible)
  - Multiple assets per pool (XLM, USDC, CETES, USTRY, EURC, TESOURO)
  - Leverage brackets: 2×, 3×, 5×, 8×, 10×

## Prerequisites

To deploy this system, you'll need:

1. **Cloudflare Account** with:
   - Cloudflare Workers (free tier OK)
   - Cloudflare D1 (SQLite database)
   - `wrangler` CLI tool

2. **Telegram**:
   - Telegram account
   - A Telegram bot (create via [@BotFather](https://t.me/botfather))
   - Bot token from BotFather

3. **Email Service** (for email alerts):
   - [Resend](https://resend.com/) API key (free tier available)
   - A verified sender email domain on Resend
   - Optional: can disable email alerts if Telegram-only is desired

4. **Node.js** 18+ and npm

## Quick Start

### 1. Install Dependencies

```bash
cd alerts
npm install
```

### 2. Set Up Cloudflare D1 Database

Create a new D1 database:

```bash
npm run db:create
```

This will output a database ID. Copy it and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "turbolong-alerts"
database_id = "your-database-id-here"
```

Then apply the schema:

```bash
npm run db:migrate
```

### 3. Configure Secrets

Store sensitive credentials via wrangler:

```bash
# Your Telegram bot token (from @BotFather)
wrangler secret put TELEGRAM_BOT_TOKEN

# Your Resend API key (from https://resend.com/api-keys)
wrangler secret put RESEND_API_KEY
```

### 4. Update Configuration

Edit `wrangler.toml` and set:

```toml
[vars]
RESEND_FROM = "alerts@yourdomain.com"        # Verified sender on Resend
FRONTEND_ORIGIN = "https://yourapp.com"      # Frontend URL for email links
```

### 5. Register Telegram Webhook

After deployment (step 6), register your bot's webhook with Telegram:

```bash
TELEGRAM_BOT_TOKEN="your-token-here"
WORKER_URL="https://turbolong-alerts.workers.dev"  # Replace with your worker URL

curl -X POST https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook \
  -d url=$WORKER_URL/telegram \
  -d allowed_updates='["message"]'
```

To verify the webhook:

```bash
curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo
```

### 6. Deploy

```bash
npm run deploy
```

After deployment, you'll see your Worker URL in the output.

## Testing Locally

To test commands locally before deploying:

```bash
npm run dev
```

This starts a local development server. You can test HTTP endpoints, but Telegram webhook won't work locally (requires public HTTPS URL).

## Usage

### As a Telegram Bot User

Start a conversation with [@TurbolongAlertsBot](https://t.me/TurbolongAlertsBot) (or your own bot username):

```
/start                              — Show help
/subscribe hf Etherfuse CETES 5    — Subscribe to alerts
/subscribe hf Fixed XLM 10         — Subscribe to another position
/positions                          — List all subscriptions
/rates                              — View current APY rates
```

When net APY turns negative, you'll receive:

```
⚠️ Negative APY Alert

CETES at 5× on Etherfuse
Net APY: -0.45%
Supply: 2.50%  Borrow cost: 5.25%

Consider reducing leverage or closing your position.
```

### Available Pools and Assets

**Etherfuse**
- XLM, USDC, CETES, USTRY, EURC

**Fixed**
- XLM, USDC, CETES, TESOURO

**YieldBlox** (placeholder; can be configured)
- XLM, USDC

Leverage brackets: **2×, 3×, 5×, 8×, 10×**

### Email Subscribers (Optional)

Email subscriptions use the same database but require email verification:

```bash
curl -X POST https://turbolong-alerts.workers.dev/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "pool_id": "CBX52SZNOC4Z3LFNRQSMZG2ZHPGDZ7CFODGS4MMUYEBWXWCUHWWYXFY5",
    "asset_symbol": "USDC",
    "leverage_bracket": 5
  }'
```

User receives verification email; clicking the link confirms the subscription.

## Database Schema

The `subscriptions` table stores all subscribers (email and Telegram):

```sql
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  email TEXT,                    -- "user@example.com" or "tg:123456789"
  pool_id TEXT,                  -- Blend pool contract address
  asset_symbol TEXT,             -- XLM, USDC, CETES, etc.
  leverage_bracket REAL,         -- 2, 3, 5, 8, or 10
  verified INTEGER,              -- 1 = active, 0 = email pending verification
  verify_token TEXT,             -- One-time verification link token
  unsub_token TEXT,              -- One-time unsubscribe link token
  telegram_chat_id INTEGER,      -- Set for Telegram subscriptions
  created_at TEXT,               -- ISO 8601 timestamp
  last_alerted_at TEXT,          -- ISO 8601, used for rate-limiting
  UNIQUE(email, pool_id, asset_symbol, leverage_bracket)
);
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│         Cloudflare Workers (Serverless)         │
├─────────────────────────────────────────────────┤
│  index.ts                                       │
│  ├─ Routes:                                     │
│  │  ├ POST /subscribe (email subscriptions)    │
│  │  ├ GET /verify?token= (email verification) │
│  │  ├ GET /unsubscribe?token= (unsubscribe)   │
│  │  └ POST /telegram (webhook handler)        │
│  │                                              │
│  └─ Cron: runs every 15 minutes                │
│     └─ Fetches reserve rates → computes APY    │
│        → queries subscriptions → sends alerts   │
│                                                 │
│  telegram.ts                                    │
│  ├─ /subscribe hf <pool> <asset> <leverage>   │
│  ├─ /positions                                 │
│  ├─ /rates                                     │
│  └─ Alert message formatting                   │
│                                                 │
│  stellar.ts                                     │
│  ├─ Blend pool reserve rate fetching           │
│  ├─ APY calculations                           │
│  └─ Soroban RPC calls (read-only)             │
│                                                 │
│  email.ts                                       │
│  ├─ Verification email templates               │
│  ├─ Alert email templates                      │
│  └─ Resend API integration                     │
└─────────────────────────────────────────────────┘
         ↓              ↓              ↓
    Cloudflare D1   Telegram Bot   Resend Email
      (SQLite)        API          Service
```

## Environment Variables

### Secrets (set with `wrangler secret put`):

| Name | Description |
|------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `RESEND_API_KEY` | API key from Resend (optional for Telegram-only) |

### Config Variables (in `wrangler.toml`):

| Name | Description | Example |
|------|-------------|---------|
| `RESEND_FROM` | Verified sender email on Resend | `alerts@yourdomain.com` |
| `FRONTEND_ORIGIN` | Frontend URL for email links | `https://app.turbolong.com` |

## Monitoring and Debugging

### View Logs

```bash
wrangler tail
```

This streams real-time logs from your Worker.

### Check Cron Execution

The cron job runs every 15 minutes (`*/15 * * * *`). Logs will show:

```
[cron] APY alert check starting...
[cron] Negative APY: CETES at 5x on Etherfuse = -0.45%
[cron] Alerting 12 subscriber(s) for CETES@5x on Etherfuse
[cron] APY alert check complete.
```

### Database Queries

Interactive shell access:

```bash
wrangler d1 shell turbolong-alerts
```

Common queries:

```sql
-- View all subscriptions
SELECT email, pool_id, asset_symbol, leverage_bracket, verified 
FROM subscriptions 
ORDER BY created_at DESC;

-- View only Telegram subscribers
SELECT telegram_chat_id, pool_id, asset_symbol, leverage_bracket 
FROM subscriptions 
WHERE telegram_chat_id IS NOT NULL 
ORDER BY created_at DESC;

-- View recent alerts
SELECT email, asset_symbol, leverage_bracket, last_alerted_at 
FROM subscriptions 
WHERE last_alerted_at > datetime('now', '-24 hours') 
ORDER BY last_alerted_at DESC;

-- Cleanup: delete old unverified subscriptions (30+ days old)
DELETE FROM subscriptions 
WHERE verified = 0 
  AND created_at < datetime('now', '-30 days');
```

## Customization

### Add a New Pool

Edit `stellar.ts` and add an entry to the `POOLS` array:

```typescript
{
  name: "NewPool",
  id: "CAAAAAAAAAAAAA...",  // Contract address
  assets: [
    { symbol: "USDC", id: "GBUQWP3..." },
    { symbol: "XLM", id: "NATIVE" },
  ],
}
```

### Adjust Cron Frequency

In `wrangler.toml`, change the `crons` trigger:

```toml
[triggers]
crons = ["*/30 * * * *"]  # Run every 30 minutes instead
```

### Disable Email Alerts

Remove Resend integration and modify `handleCron` in `index.ts` to only send Telegram alerts.

## Troubleshooting

### "Webhook error: 403 Forbidden"

Ensure `setWebhook` is called with the correct bot token and Worker URL is publicly accessible:

```bash
curl https://api.telegram.org/bot$TOKEN/getMe
```

### "Database error"

Check that D1 is bound correctly in `wrangler.toml` and the schema is applied:

```bash
npm run db:migrate
```

### No alerts being sent

1. Check cron logs: `wrangler tail`
2. Verify subscriptions exist: `wrangler d1 shell turbolong-alerts`
3. Verify Soroban RPC is accessible (check `stellar.ts` error logs)
4. Check last_alerted_at timestamps (rate-limited to 24h)

### "Invalid or expired token" on verify/unsubscribe

Tokens are valid for 7 days. Create a new subscription or manually update the database:

```sql
UPDATE subscriptions SET verified = 1 WHERE email = 'user@example.com';
```

## Development

### Project Structure

```
alerts/
├── src/
│   ├── index.ts         — Worker entry, route handlers, cron
│   ├── telegram.ts      — Telegram bot commands & alerts
│   ├── email.ts         — Email templates & Resend API
│   ├── stellar.ts       — Blend rate fetching & APY calculation
│   ├── xdr.ts           — Soroban XDR encoding/decoding
│   └── schema.sql       — D1 database schema
├── wrangler.toml        — Worker config
├── tsconfig.json        — TypeScript config
├── package.json         — Dependencies & scripts
└── README.md            — This file
```

### Building

```bash
npm run dev      # Local dev server
npm run deploy   # Deploy to production
```

## Cost Estimates

On Cloudflare's free tier:

- **Workers**: 100,000 requests/day (free)
- **D1**: 1 million reads/month (free)
- **Resend Email**: $0.20 per 100 emails or free tier

For typical usage (1000 subscribers, alert every 3 days):
- Workers: ~3% of free quota
- D1: <100K reads/month
- Email: ~$0.30–1.00/month

## Contributing

To add features or fix bugs:

1. Clone and set up the repo
2. Test locally: `npm run dev`
3. Deploy to staging: `npm run deploy` with a test Worker
4. Create a pull request with your changes

## License

This project is part of Turbolong. See the main LICENSE file.
