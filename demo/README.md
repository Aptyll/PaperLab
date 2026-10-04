# Demo data

`data/` holds one recorded Paper Lab session for the public demo site. It is
written by `node scripts/export-demo.js --session=N` on the computer that ran the
session, then published to GitHub Pages by `.github/workflows/pages.yml`
(built with `scripts/build-site.js`).

It contains paper trades, public coin names, prices, pool and token addresses
(public contracts, not wallets), bot settings and the research notes. The export
checks for folder paths, email addresses and keys and stops if it finds any.
