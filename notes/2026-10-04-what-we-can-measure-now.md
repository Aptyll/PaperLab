# What we can measure now, and what needs something new

*Claude's research on Noah's signal list, 2026-10-04. "Checked" means confirmed in the provider's documentation or a published price list; "unchecked" means it still needs a test on Noah's computer, since the cloud can't reach these sites.*

## Already in Paper Lab (free GeckoTerminal data, saved every minute)

- **Unique buyers versus unique sellers** for the last 5 minutes, hour and day. The Buy rush rule already uses the 5-minute numbers.
- **Liquidity relative to market cap.** Shown on every coin's page; the Deep pool rule trades on it.
- **Volume to market cap (turnover).** New: the Coins page and each coin's page show it with three labels (attention, distribution, fading), and a Turnover check table measures what prices did an hour after each label. The cut-offs are guesses until that table fills up.
- **Divergence view, on-chain half.** Price change against unique buyers is possible today from saved readings. Not built yet.

## Free, but needs new code

- **Top-10 holder share.** GeckoTerminal's token info gives holder count and the share held by the top 10 (checked in its docs; marked beta, and counts exchange and team wallets too). One extra call per coin, so it would be checked every few minutes, not every minute.
- **The coin's X and Telegram handles.** The same token info call returns them (checked). This is the link from a coin to its social accounts.
- **Wallet-level trades.** GeckoTerminal returns a pool's last 300 trades with the wallet behind each one (checked). That gets us part of the way to dev wallet selling, sniper wallets in the first blocks, and a smart wallet tracker. Older history needs the public Solana network itself, which is free but slow and strictly limited (unchecked).
- **Telegram member counts.** A public group's t.me page shows its member count without any account (checked in a write-up, unchecked by us). It is rounded, so it only shows big changes.
- **Rate limit.** CoinGecko's page now says about 10 calls a minute without a key for these endpoints, not the 30 Paper Lab was built around (checked on their page via search, unchecked in practice). Paper Lab uses 1 to 2 a minute today, so there is room, but extra per-coin calls have to be rationed.

## Needs a paid service or an API key (ask Noah first)

- **X followers, likes, replies and views.** The official X API has no free tier for new developers. It now charges per read, about $0.01 per account lookup and $0.005 per post (from published price guides; X's own page couldn't be opened from here). One coin checked with its 10 latest posts is about $0.06, so 20 coins every 15 minutes is roughly $115 a day. Third-party providers (twitterapi.io, SocialData, Apify) are listed at roughly $0.15 to $0.40 per 1,000 posts, about 100 times cheaper, but they collect X data in ways X doesn't sanction and can stop working without warning.
- **Fresh wallets funded from one source, bundles.** No free, keyless source found. Helius (free plan, needs a key) or RugCheck (may need a key) make this practical.
- **Narrative tagging with AI.** Needs the Anthropic key Paper Lab already has a switch for.

## A suggested order

1. Let the Turnover check collect for a day or two and see if any label beats "Any reading".
2. Add top-10 holder share and social handles from GeckoTerminal token info (free).
3. Add the divergence view: price rising while unique buyers are flat.
4. Decide on X data only once the free signals show whether this kind of reading predicts anything.
