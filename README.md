# humming-facade

The XRPC facade server for Humming: a translation layer that connects a nearly unmodified Bluesky web app ([humming-app](https://github.com/GeunhwaJeong/humming-app)) to the Haneul blockchain.

The app speaks standard ATProto XRPC. The chain speaks Move objects and events. This server sits in between:

- **Reads**: converts on-chain posts (feed module records) into `getTimeline` / `getAuthorFeed` / `getPostThread` responses.
- **Gating**: decides view entitlement server-side from on-chain state: subscriptions (`Subscribed`), single-post purchases (`PostPurchased`), and profile locks (`PrefsChanged`). Responses for non-entitled viewers have the body and media stripped entirely. Events are indexed with a checkpoint cursor (`lib/indexer.mjs`) and kept as in-memory state: live checkpoints arrive over a gRPC `SubscribeCheckpoints` stream, and gaps after a restart are backfilled with `GetCheckpoint` calls that fetch events only (`lib/grpc.mjs`). This keeps the read path off the JSON-RPC query APIs, which upstream is deprecating.
- **Writes**: assembles post creation, subscriptions, tips, and single-post purchases as `@haneullabs/haneul` SDK Transactions and submits them with in-process signing (`lib/chain.mjs`). Submissions are serialized per signer wallet only; transactions from different wallets run in parallel.
- **Transport**: every chain access, including reads, writes, object reconstruction, balances, and name lookups, goes over the full node's gRPC API. The runtime has no JSON-RPC dependency, so the upstream removal of the public JSON-RPC query APIs does not affect this server. Transport equivalence is checked by `verify-grpc-tailing.mjs` (events) and `verify-grpc-reads.mjs` (objects, balances, name records).
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
- **An APP_WALLET signing key** must be present in the wallet key store to sign signups (name issuance, starter gas, and sponsored gas).

Signup funding: on a chain without a faucet, APP_WALLET handles name issuance and the starter gas grant in a **single PTB** at signup. Tune the starter amount with `HUMMING_STARTER_GEUNHWA` (default 200,000,000 = 0.2 of the gas coin, capped at 10). The daily spend ceiling is the starter amount times `HUMMING_MAX_SIGNUPS_PER_DAY`.

Sponsored gas: on networks where `SPONSOR_GAS` is on (the default for the `sui-*` network map entries, override with `HUMMING_SPONSOR_GAS=0/1`), every user transaction is co-signed by APP_WALLET as the gas owner, so user wallets never hold the gas coin. Starter gas is therefore **not** granted on those networks, and a signup on a network without a name service touches the chain not at all. The payment coin (e.g. USDC) is separate from the gas coin; `app.humming.wallet.getInfo` reports the payment coin balance.

Tips are capped per transaction at `HUMMING_TIP_MAX_UNITS` display units of the payment coin (default 100), converted with the coin's decimals so the cap means the same thing on 6- and 9-decimal coins. The platform fee shown to creators comes from the on-chain `FeeConfig` (`feeBps` in `app.humming.creator.getEarnings` / `app.humming.monetization.getCreator`), never from a hardcoded number.

State backups: the facade snapshots its durable state (key store, accounts, JWT secret, indexer cursor) into a rotating local directory at boot, every 6 hours, and shortly after any key or account change. Tune with `HUMMING_BACKUP_DIR` (default `./backups`), `HUMMING_BACKUP_KEEP` (default 48), `HUMMING_BACKUP_INTERVAL_MS`, and set `HUMMING_BACKUP_CMD` to replicate each snapshot offsite (the command runs with `HUMMING_BACKUP_PATH` pointing at the new snapshot, e.g. an `rclone copy`). Each snapshot carries a `manifest.json` with per-file SHA-256 hashes; to restore, verify the hashes, copy the files back to the repo root, and restart.

Other environment variables: `PORT` (default 3025), `HUMMING_GRPC_URL` (defaults to `HUMMING_RPC_URL`; the full node serves gRPC multiplexed on the same port), `HUMMING_MEDIA_DIR`, `HUMMING_FAUCET_URL`, `HUMMING_TRUST_PROXY=1` (only behind a reverse proxy), and rate limit tuning: `HUMMING_LOGIN_IP_LIMIT` (20 per 5 min), `HUMMING_LOGIN_ACCT_LIMIT` (10 per 15 min), `HUMMING_SIGNUP_IP_LIMIT` (5 per hour), `HUMMING_MAX_SIGNUPS_PER_DAY` (200). Rate limits are effectively lifted on localnet so they never get in the way of E2E runs.

## Profile media and search

- **Avatar and banner**: `putRecord` on `app.bsky.actor.profile` accepts the `avatar` / `banner` blob references the app writes after `uploadBlob`. Only images the account itself uploaded are accepted (the upload's recorded owner must match), which keeps a paywalled image from being registered as someone's avatar and served publicly. Registered profile images are served from `GET /img/:cid` with immutable caching; every other CID on that route is 404. `getRecord` returns the blobs so the app's edit dialog preserves them.
- **Search**: `app.bsky.actor.searchActors` / `searchActorsTypeahead` match handle and display name (handle prefix first, then display-name prefix, then substring; offset cursor). `app.bsky.feed.searchPosts` matches post text after gating for the viewer, so locked posts never surface. `app.bsky.actor.getSuggestions` returns creators (accounts with a subscription tier).

## Moderation

The product allows adult content and moderates hard, so the serving layer has the four levers that policy needs:

- **Delete**: `com.atproto.repo.deleteRecord` on a post calls `feed::delete_post` with the author's key (the chain enforces authorship), the index drops the post on the `PostDeleted` event, and media files no live post still references are removed from `media/`.
- **Self-labels**: the composer's content warnings (`porn`, `sexual`, `nudity`, `graphic-media`) are stored with the post (`§labels:` marker in `content_uri`, see `lib/content.mjs`) and returned as labels with `src` = the author's DID, so the app's built-in adult-content handling applies. Other label values are dropped.
- **Preferences**: `app.bsky.actor.putPreferences` persists the app's preference array per account (adult content toggle, per-label visibility, saved feeds, the birth date the user gave at signup). Nothing is fabricated server-side.
- **Reports**: `com.atproto.moderation.createReport` appends to `reports.<network>.jsonl`.
- **Operator hide**: with `HUMMING_ADMIN_TOKEN` set, `GET /admin/reports`, `GET /admin/hidden`, `POST /admin/hide {postId, reason}` and `POST /admin/unhide {postId}` (bearer token) manage `hidden-posts.<network>.json`. Hidden posts leave every view immediately without a chain transaction and can be restored. Both files are backed up with the rest of the state.

## E2E

The `e2e-*.mjs` scripts drive the real web app with Playwright to verify the main scenarios: signup, subscription paywall, fully locked profiles, media gating, and single-post purchase. The `e2e-*.png` files are execution evidence for each scenario.

## Status

Early stage. Account keys are held server-side (custodial, `wallet-keys.json`); a move to non-custodial signing based on zkLogin / passkeys is on the roadmap. `accounts.json` (signed-up accounts), `wallet-keys.json` (wallet secret keys), and `media/` (uploaded bytes) are runtime data and are never committed.
