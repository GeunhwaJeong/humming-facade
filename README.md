# humming-facade

The XRPC facade server for Humming: a translation layer that connects a nearly unmodified Bluesky web app ([humming-app](https://github.com/GeunhwaJeong/humming-app)) to the Haneul blockchain.

The app speaks standard ATProto XRPC. The chain speaks Move objects and events. This server sits in between:

- **Reads**: converts on-chain posts (feed module records) into `getTimeline` / `getAuthorFeed` / `getPostThread` responses.
- **Gating**: decides view entitlement server-side from on-chain state: subscriptions (`Subscribed`), single-post purchases (`PostPurchased`), and profile locks (`PrefsChanged`). Responses for non-entitled viewers have the body and media stripped entirely. Events are indexed with a cursor from genesis (`lib/indexer.mjs`) and kept as in-memory state.
- **Writes**: assembles post creation, subscriptions, tips, and single-post purchases as `@haneullabs/haneul` SDK Transactions and submits them with in-process signing (`lib/chain.mjs`). Submissions are serialized per signer wallet only; transactions from different wallets run in parallel.
- **Signup = handle = wallet**: a single `createAccount` call creates a wallet and issues an on-chain `name.hum.haneul` subname ([haneulns](https://github.com/GeunhwaJeong/haneulns-contracts) leaf record, gas sponsored by the server).
- **Media**: file bytes stay off-chain (`media/`); only the CID pointer goes on chain. HMAC-signed URLs are issued to entitled viewers only.

## Running

A localnet and deployed contracts must exist first. Update `lib/config.mjs` (package and shared object addresses) to your deployment values, then:

```bash
npm install
node server.mjs   # http://localhost:3025
```

If you recreated the localnet with `--force-regenesis`, delete `accounts.json` (signed-up accounts) and `wallet-keys.json` (wallet key store) before starting: they are stale values whose on-chain originals no longer exist. Seed account keys are imported automatically from the CLI keystore at boot.

Session JWTs carry real HS256 signatures. The signing secret comes from the `HUMMING_JWT_SECRET` environment variable if set, otherwise from `.jwt-secret` (0600) generated on first boot. Deleting that file invalidates every session, which makes it a force-logout-all switch. Account passwords are stored only as scrypt hashes, and verification is async so a login flood cannot pin the event loop.

Boot is fail-closed: every XRPC endpoint returns 503 until the chain event backfill has **fully** completed (check readiness at `/health`). Judging paywall locks from a partial index would open a window on every restart where paid content leaks.

## Deploying (beyond localnet)

Set `HUMMING_ENV=production` in deployed environments. It forces the production posture (no seed accounts, real rate limits, no faucet) regardless of the RPC URL. A non-localhost URL gets the same posture as well.

The localnet posture only opens after the server verifies the actual chain identity at boot: if `127.0.0.1` turns out to point at a mainnet full node (chain `a0053d9e`), boot is refused. If the chain identity cannot be verified at all (chain down), the server refuses to boot into the localnet posture too.

Boot requirements for the production posture (boot is refused if unmet):

- **Seed demo accounts are excluded automatically** (they exist for the localnet posture only). Boot fails if any remain.
- `HUMMING_KEYS_PASSPHRASE`: seals the custodial wallet key store with scrypt + AES-256-GCM at rest. A legacy plaintext store is migrated automatically on the first boot with the passphrase set. Losing the passphrase means losing the keys, so store it in a password manager.
- `HUMMING_PUBLIC_URL`: the external address baked into signed media URLs (e.g. `https://api.humming.social`).
- `HUMMING_APP_ORIGINS`: comma-separated list of allowed CORS origins (e.g. `https://humming.social`).
- **An APP_WALLET signing key** must be present in the wallet key store to sign signups (name issuance plus starter gas).

Signup funding: on a chain without a faucet, APP_WALLET handles name issuance and the starter gas grant in a **single PTB** at signup. Tune the starter amount with `HUMMING_STARTER_GEUNHWA` (default 200,000,000 = 0.2 HANEUL, capped at 10 HANEUL). The daily spend ceiling is the starter amount times `HUMMING_MAX_SIGNUPS_PER_DAY`.

State backups: the facade snapshots its durable state (key store, accounts, JWT secret, indexer cursor) into a rotating local directory at boot, every 6 hours, and shortly after any key or account change. Tune with `HUMMING_BACKUP_DIR` (default `./backups`), `HUMMING_BACKUP_KEEP` (default 48), `HUMMING_BACKUP_INTERVAL_MS`, and set `HUMMING_BACKUP_CMD` to replicate each snapshot offsite (the command runs with `HUMMING_BACKUP_PATH` pointing at the new snapshot, e.g. an `rclone copy`). Each snapshot carries a `manifest.json` with per-file SHA-256 hashes; to restore, verify the hashes, copy the files back to the repo root, and restart.

Other environment variables: `PORT` (default 3025), `HUMMING_MEDIA_DIR`, `HUMMING_FAUCET_URL`, `HUMMING_TRUST_PROXY=1` (only behind a reverse proxy), and rate limit tuning: `HUMMING_LOGIN_IP_LIMIT` (20 per 5 min), `HUMMING_LOGIN_ACCT_LIMIT` (10 per 15 min), `HUMMING_SIGNUP_IP_LIMIT` (5 per hour), `HUMMING_MAX_SIGNUPS_PER_DAY` (200). Rate limits are effectively lifted on localnet so they never get in the way of E2E runs.

## E2E

The `e2e-*.mjs` scripts drive the real web app with Playwright to verify the main scenarios: signup, subscription paywall, fully locked profiles, media gating, and single-post purchase. The `e2e-*.png` files are execution evidence for each scenario.

## Status

Early stage. Account keys are held server-side (custodial, `wallet-keys.json`); a move to non-custodial signing based on zkLogin / passkeys is on the roadmap. `accounts.json` (signed-up accounts), `wallet-keys.json` (wallet secret keys), and `media/` (uploaded bytes) are runtime data and are never committed.
