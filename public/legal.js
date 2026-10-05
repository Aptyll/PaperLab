// @ts-check
// The Legal page (#/legal): for a lawyer looking at Paper Lab. What the app is
// and is not, the crypto rules around it, and the questions worth a lawyer's
// time. Static text, the same on the public demo.
//
// Crypto rules change fast. Everything here was checked on CHECKED; when you
// update a section, update its sources and that date too.

const CHECKED = 'October 5, 2026';

/** A source link that opens in a new tab. @param {string} label @param {string} url */
const src = (label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;

/** @typedef {'settled' | 'changing' | 'unsettled'} Status */

/** @type {Record<Status, {label: string, tip: string}>} */
const STATUS = {
  settled: { label: 'Settled', tip: 'Long-standing law or guidance, unlikely to change soon.' },
  changing: { label: 'Changing', tip: 'The rules exist but moved recently or are being rewritten.' },
  unsettled: { label: 'Unsettled', tip: 'No clear answer yet: courts, regulators or Congress have not decided.' },
};

/**
 * @typedef {Object} Section
 * @property {string} id       Anchor, so #/legal/<id> lands here
 * @property {string} title
 * @property {Status} [status]
 * @property {string} body     HTML
 * @property {string[]} [sources]  HTML links
 */

/** @type {Section[]} */
const SECTIONS = [
  {
    id: 'what-it-is',
    title: 'What Paper Lab is, and is not',
    body: `
      <p>Paper Lab is free software that runs on one person's own computer. It watches trending Solana memecoins using free public market data and makes <b>pretend trades</b> with pretend money, to test whether simple buying rules beat picking coins at random.</p>
      <table class="t compact legal-facts"><tbody>
        <tr><td>Money</td><td>Pretend only. Each bot starts with a pretend $1,000. No real money moves.</td></tr>
        <tr><td>Wallets and keys</td><td>None. It cannot connect to a wallet, holds no private keys and never takes custody of anything.</td></tr>
        <tr><td>Orders</td><td>None. There is no code that places, routes or signs a real trade. If a person trades for real, they do it by hand, in their own wallet, outside Paper Lab.</td></tr>
        <tr><td>Data in</td><td>Read-only public market data (prices, liquidity, volume) from the free ${src('GeckoTerminal', 'https://www.geckoterminal.com')} API.</td></tr>
        <tr><td>Data out</td><td>Nothing by default. The app only answers requests from the same computer (localhost). An optional AI scoring feature is off by default; if a user turns it on with their own Anthropic key, it sends a trade's public market data to Anthropic's API.</td></tr>
        <tr><td>Users and accounts</td><td>None. No sign-up, no payments, no fees, no ads, no personal data collected.</td></tr>
        <tr><td>What it shows</td><td>Each bot's pretend results against its own random picker, and a "Hot now" list: coins a rule just fired on, with how often that rule's past pretend trades hit their target and how many trades that is based on. The same for everyone who runs it; nothing is tailored to a person.</td></tr>
        <tr><td>Public demo</td><td>A static website on GitHub Pages that replays one recorded session, read-only. It has no live data and no server of its own. It links to free downloads of the app.</td></tr>
      </tbody></table>
      <p>These facts come from the app's source code, which is public on ${src('GitHub', 'https://github.com/Aptyll/PaperLab')}.</p>`,
  },
  {
    id: 'short-version',
    title: 'The short version',
    body: `
      <p>Our reading, for a lawyer to test, not a conclusion:</p>
      <ul>
        <li><b>The software itself</b> probably sits outside most licensing regimes in the US, EU and UK, because it holds nothing, executes nothing and gives the same impersonal information to everyone. No source we found addresses a free paper-trading tool directly, so this is inference.</li>
        <li><b>The softest spots</b> are how it is presented: whether the "Hot now" list with hit rates could read as investment advice or, in the UK, as a financial promotion; and whether pretend results could be read as a promise of real profits.</li>
        <li><b>The bigger risks belong to real trading</b>, if anyone does it by hand: tax on every swap, losses to rug pulls and fraud, and sanctions exposure. Paper Lab does not change those duties.</li>
        <li><b>US rules on memecoins moved a lot in 2025 and 2026</b>, mostly toward "not securities", but Congress has not passed a market structure law and most of the new guidance can be changed by regulators.</li>
      </ul>`,
  },
  {
    id: 'us-securities',
    title: 'US: are memecoins securities?',
    status: 'changing',
    body: `
      <p><b>Today's answer from the SEC: generally no.</b> On March 17, 2026 the SEC, coordinating with the CFTC, issued an interpretive release sorting crypto assets into five groups: digital commodities, digital collectibles, digital tools, stablecoins and digital securities. It names meme coins as an example of <b>digital collectibles</b>, which are not securities unless they are sold as part of an "investment contract" (the long-standing <i>Howey</i> test: money put into a common enterprise expecting profit from others' efforts). It also says a meme coin could later become a digital commodity if it gains a use inside a crypto system.</p>
      <p>This builds on a February 27, 2025 staff statement from the SEC's Division of Corporation Finance that took the same view of typical memecoins, while noting that fraud can still be pursued under other laws.</p>
      <p><b>What could change it.</b> An interpretive release reflects the current Commission's view; a future Commission can revise it, and courts are not bound by it. A coin sold with promises of profit from a team's work could still be an investment contract. On August 18, 2026 the SEC also proposed "Regulation Crypto Assets" (new offering exemptions and a safe harbor for token projects); comments close October 20, 2026, so it is not final and is aimed at token issuers, not at tools like Paper Lab.</p>`,
    sources: [
      src('DLA Piper on the March 2026 release', 'https://www.dlapiper.com/en-us/insights/publications/2026/03/sec-and-cftc-issue-interpretive-release-on-crypto'),
      src('Sidley on the March 2026 release', 'https://datamatters.sidley.com/2026/03/24/sec-releases-landmark-interpretation-on-application-of-u-s-securities-laws-to-crypto-assets-in-coordination-with-cftc/'),
      src('WilmerHale on the Feb 2025 staff statement', 'https://www.wilmerhale.com/en/insights/client-alerts/20250313-the-state-of-meme-coin-regulation-sec-staffs-statement-and-other-considerations'),
      src('Federal Register: Regulation Crypto Assets (proposed)', 'https://www.federalregister.gov/documents/2026/08/21/2026-17183/regulation-crypto-assets'),
    ],
  },
  {
    id: 'us-cftc',
    title: 'US: commodities and the CFTC',
    status: 'changing',
    body: `
      <p>If a memecoin is not a security, it is most likely a commodity. The CFTC does not license spot crypto trading, but it can bring cases for <b>fraud and manipulation</b> in spot commodity markets (Commodity Exchange Act section 6(c)(1) and CFTC Rule 180.1). The CFTC said it will apply the law consistently with the March 2026 release.</p>
      <p>The CFTC has been widening its crypto role: a "crypto sprint" from August 2025, the first leveraged spot crypto product on a CFTC-regulated exchange in December 2025, and a 2026 agenda under Chairman Michael Selig (confirmed December 2025) that includes rules on DeFi and AI trading. None of it is aimed at paper-trading tools, but it is moving.</p>`,
    sources: [
      src('17 CFR 180.1 (anti-fraud rule)', 'https://www.ecfr.gov/current/title-17/chapter-I/part-180/section-180.1'),
      src('WilmerHale on Chairman Selig', 'https://www.wilmerhale.com/en/insights/client-alerts/20251218-michael-selig-confirmed-as-cftc-chairman---six-issues-to-watch-in-2026'),
      src('Morrison Foerster on listed spot crypto', 'https://www.mofo.com/resources/insights/251210-cftc-announces-launch-of-first-leveraged-spot-cryptocurrency'),
    ],
  },
  {
    id: 'us-congress',
    title: 'US: what Congress has and has not passed',
    status: 'unsettled',
    body: `
      <p><b>Passed: the GENIUS Act</b> (signed July 18, 2025), a federal licensing and reserve regime for payment stablecoins. Regulators are still writing its rules. It does not cover memecoins.</p>
      <p><b>Not passed: a market structure law.</b> The House passed the CLARITY Act in July 2025, and two Senate committees advanced their own versions in 2026. On September 15, 2026 the Senate vote to open debate failed 49 to 50, short of the 60 needed. Commentators treat it as stalled for this Congress, though it could come back. So there is still no federal statute deciding which crypto assets the SEC or the CFTC oversees; that split rests on agency guidance.</p>`,
    sources: [
      src('CRS on the GENIUS Act', 'https://www.congress.gov/crs-product/IN12553'),
      src('H.R. 3633, CLARITY Act', 'https://www.congress.gov/bill/119th-congress/house-bill/3633'),
      src('Troutman Pepper Locke after the failed vote', 'https://www.troutman.com/insights/in-the-wake-of-clarity-acts-failure-agencies-move-forward-without-congressional-action-or-certainty/'),
    ],
  },
  {
    id: 'us-advice',
    title: 'US: is Paper Lab giving investment advice?',
    status: 'unsettled',
    body: `
      <p>This is the question most specific to Paper Lab. Three regimes could be asked about:</p>
      <ul>
        <li><b>Investment Advisers Act.</b> It only covers advice about securities. If memecoins are not securities, it likely does not reach Paper Lab. Even for securities, the Supreme Court in <i>Lowe v. SEC</i> (1985) excluded bona fide, impersonal publications of general and regular circulation.</li>
        <li><b>Commodity trading adviser rules.</b> These cover advice on futures, swaps and leveraged retail commodity deals, which unleveraged spot memecoin trades may fall outside. Separately, CFTC Rule 4.14(a)(9) exempts advice given through standardized materials, websites or non-customized software that is not tailored to a client.</li>
        <li><b>Broker rules for crypto front ends.</b> An April 13, 2026 SEC staff statement said certain crypto "user interfaces" need not register as brokers if, among other conditions, they hold no customer funds and do not solicit or recommend specific trades. Paper Lab does not prepare trades at all, but the statement shows the line regulators draw: impersonal tools are treated differently from recommendations.</li>
      </ul>
      <p>We found no authority applying any of this to free paper-trading software that publishes rule hit rates. The design choices that keep Paper Lab on the safer side: the same output for everyone, no tailoring to a person's money or goals, no "buy" calls, sample sizes shown next to every rate, and every result labeled as pretend.</p>`,
    sources: [
      src('Lowe v. SEC, 472 U.S. 181 (1985)', 'https://supreme.justia.com/cases/federal/us/472/181/'),
      src('17 CFR 4.14 (CTA exemptions)', 'https://www.ecfr.gov/current/title-17/chapter-I/part-4/subpart-A/section-4.14'),
      src('WilmerHale on the April 2026 user interface statement', 'https://www.wilmerhale.com/en/insights/client-alerts/20260417-sec-staff-issues-broker-dealer-registration-guidance-for-certain-user-interfaces'),
    ],
  },
  {
    id: 'us-marketing',
    title: 'US: claims about results',
    status: 'settled',
    body: `
      <p>The FTC treats false or unsupported earnings claims as deceptive under section 5 of the FTC Act, and has settled a case over a crypto trading bot's profit claims (2022). Paper Lab is free and sells nothing, which lowers the risk, but anything published about it (the demo, the README, social posts) should not suggest that pretend results are real or typical, and should keep the "pretend money" and "not advice" labels.</p>`,
    sources: [src('FTC on a $2.6M crypto bot settlement (2022)', 'https://www.ftc.gov/business-guidance/blog/2022/11/26-million-settlement-addresses-earnings-claims-business-opportunities-crypto-bot-consumer-review')],
  },
  {
    id: 'us-fraud',
    title: 'US: fraud, manipulation and rug pulls',
    status: 'settled',
    body: `
      <p>Whatever a memecoin is called, lying to buyers is still a crime. Federal wire fraud, CFTC anti-fraud rules and state laws all apply. Common memecoin schemes:</p>
      <ul>
        <li><b>Rug pull:</b> the creator drains the coin's trading pool and the price goes to near zero. Paper Lab tags some warning signs (copycat tickers, very new pools) but cannot detect rugs reliably.</li>
        <li><b>Pump and dump:</b> insiders hype a coin, then sell into the buying.</li>
        <li><b>Wash trading:</b> trading with yourself to fake volume. In "Operation Token Mirrors" (October 2024) the FBI created its own token to catch market makers selling fake volume, and 18 people and firms were charged.</li>
      </ul>
      <p><b>Enforcement priorities.</b> An April 7, 2025 Justice Department memo ("Ending Regulation by Prosecution") moved away from charging purely regulatory violations but kept fraud on investors and scams as priorities. Courts have also limited some theories: in May 2025 a judge vacated the Mango Markets manipulation and fraud convictions.</p>
      <p><b>Private lawsuits.</b> On August 31, 2026 a federal judge let racketeering (RICO) claims proceed against pump.fun's parent company and founders, while dismissing claims against Solana Labs and the Solana Foundation. A separate class action over the $LIBRA memecoin was reported dismissed in September 2026. These cases target issuers and launch platforms, not information tools.</p>
      <p>Paper Lab's pretend trades are not real orders, so they cannot move a market. The risk to watch is publishing information about specific coins that is knowingly false or misleading.</p>`,
    sources: [
      src('DOJ: Operation Token Mirrors (Oct 2024)', 'https://www.justice.gov/usao-ma/pr/eighteen-individuals-and-entities-charged-international-operation-targeting-widespread'),
      src('White & Case on the April 2025 DOJ memo', 'https://www.whitecase.com/insight-alert/doj-announces-policy-ending-regulation-prosecution-digital-assets'),
      src('Aguilar v. Baton Corp. (pump.fun) docket', 'https://www.courtlistener.com/docket/69593359/aguilar-v-baton-corporation-ltd-dba-pumpfun/'),
      src('Wolf Popper on the August 2026 ruling', 'https://www.wolfpopper.com/news/court-allows-rico-claims-against-pumpfun-and-founders-to-proceed'),
    ],
  },
  {
    id: 'us-tax',
    title: 'US: tax',
    status: 'settled',
    body: `
      <p><b>Pretend trades are not taxed.</b> Nothing is bought or sold. (Our inference; no source addresses paper trading directly.)</p>
      <p><b>Real trades are.</b> The IRS treats crypto as property (Notice 2014-21). Every sale or swap is a taxable event, including swapping a memecoin for SOL on a decentralized exchange. Held a year or less, gains are short-term and taxed at ordinary income rates; losses can offset gains. Form 1040 asks every filer whether they sold or exchanged a digital asset.</p>
      <ul>
        <li><b>Form 1099-DA.</b> Custodial brokers (centralized exchanges, hosted wallets) report gross proceeds for 2025 sales and cost basis for 2026 sales of assets bought after 2025. Congress repealed the rule that would have covered DeFi front ends (April 10, 2025). So self-custody trades on a decentralized exchange usually get <b>no form</b>, but must still be reported.</li>
        <li><b>Basis per wallet.</b> Since January 1, 2025, cost basis must be tracked separately for each wallet or account (Rev. Proc. 2024-28).</li>
        <li><b>Wash sales.</b> The wash-sale rule still does not apply to crypto, and there is no small-transaction exemption. A House committee approved a bill in September 2026 that would change both; it is not law.</li>
      </ul>`,
    sources: [
      src('IRS: digital assets', 'https://www.irs.gov/businesses/small-businesses-self-employed/digital-assets'),
      src('H.J.Res. 25 (DeFi broker rule repeal)', 'https://www.congress.gov/bill/119th-congress/house-joint-resolution/25'),
      src('Rev. Proc. 2024-28', 'https://www.irs.gov/pub/irs-drop/rp-24-28.pdf'),
      src('CoinDesk on the 2026 House tax bill', 'https://www.coindesk.com/policy/2026/09/14/u-s-house-panel-shares-crypto-tax-bill-ahead-of-hearing-later-this-week'),
    ],
  },
  {
    id: 'us-aml',
    title: 'US: KYC, money laundering and sanctions',
    status: 'changing',
    body: `
      <p><b>Paper Lab moves no money, so money transmitter and KYC rules should not reach it.</b> FinCEN's 2019 guidance says people trading from their own unhosted wallet are not money transmitters, and neither are makers of software that never holds or controls users' funds. The test is custody and control.</p>
      <p><b>Developer liability is still being fought over.</b> Roman Storm, a Tornado Cash developer, was convicted in August 2025 of conspiring to run an unlicensed money transmitting business; his motion to overturn it is pending and a retrial on other counts is set for April 2027. The Samourai Wallet founders pleaded guilty and were sentenced in November 2025. In August 2025 the Justice Department said it would not bring new unlicensed money transmitting charges against developers of truly decentralized, non-custodial software without criminal intent, but that is policy, not law. These cases involved software that moved real funds; Paper Lab moves none.</p>
      <p><b>Sanctions apply to everyone.</b> US persons may not deal with people or crypto addresses on OFAC's sanctions list, with or without KYC, and liability does not require intent. That matters for anyone trading real tokens by hand.</p>`,
    sources: [
      src('FinCEN guidance FIN-2019-G001', 'https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf'),
      src('Treasury: Tornado Cash delisting (March 2025)', 'https://home.treasury.gov/news/press-releases/sb0057'),
      src('United States v. Storm docket', 'https://www.courtlistener.com/docket/67720380/united-states-v-storm/'),
      src('IRS-CI: Samourai Wallet sentencing', 'https://www.irs.gov/compliance/criminal-investigation/founders-of-samourai-wallet-cryptocurrency-mixing-service-sentenced-to-five-and-four-years-in-prison'),
      src('WilmerHale on DOJ and developers (Aug 2025)', 'https://www.wilmerhale.com/en/insights/client-alerts/20250910-doj-signals-approach-to-digital-assets-what-it-means-for-developers-and-platforms'),
    ],
  },
  {
    id: 'eu',
    title: 'EU: MiCA',
    status: 'changing',
    body: `
      <p>The Markets in Crypto-Assets Regulation (MiCA) has applied in full since December 30, 2024. The grace period for existing crypto firms ended on July 1, 2026, so anyone providing crypto services to EU customers now needs a MiCA license.</p>
      <ul>
        <li><b>Memecoins</b> are "other crypto-assets" under Title II. Whoever offers one to the public or seeks a listing needs a white paper, but a coin with <b>no identifiable issuer</b> falls outside those duties (Recital 22). Whether a coin with a known creator has an "identifiable issuer" depends on the facts.</li>
        <li><b>Advice</b> is a licensed service only when it is a <b>personalised</b> recommendation. ESMA reads that broadly, but its test excludes information issued only to the public at large. Impersonal, identical-for-everyone information like Paper Lab's should normally fall outside. No ESMA text speaks to signal tools directly.</li>
        <li><b>Market abuse</b> rules (insider dealing, manipulation, spreading misleading signals) apply to anyone, anywhere, but only for coins admitted to trading on an EU platform.</li>
        <li><b>Travel rule and tax reporting</b> (DAC8, from January 1, 2026) fall on crypto service providers, not on information tools or self-custody users.</li>
        <li><b>Coming:</b> a December 2025 Commission proposal would move supervision of crypto firms to ESMA. It is not law yet.</li>
      </ul>`,
    sources: [
      src('MiCA, Regulation (EU) 2023/1114', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1114'),
      src('ESMA: MiCA', 'https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica'),
      src('ESMA Q&A 2882 (advice)', 'https://www.esma.europa.eu/publications-data/questions-answers/2882'),
      src('European Commission: DAC8', 'https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/directive-administrative-cooperation-dac/dac8_en'),
    ],
  },
  {
    id: 'uk',
    title: 'UK',
    status: 'changing',
    body: `
      <ul>
        <li><b>Financial promotions (since October 8, 2023).</b> Communicating an invitation or inducement to invest in crypto, in the course of business, to people in the UK must be made or approved by an authorised or registered firm. It applies to websites outside the UK that can be seen there. The FCA's finfluencer guidance reads "course of business" widely. Purely factual information is less likely to count, but naming coins with hit rates is closer to an inducement than plain education. <b>This is the most likely UK question for the public demo.</b></li>
        <li><b>New licensing regime.</b> The Cryptoassets Regulations 2026 (SI 2026/102, made February 2026) create licensed activities such as running a trading platform, dealing, arranging, custody and staking. Advice is not on the list. The regime starts on <b>October 25, 2027</b>; firms apply between September 30, 2026 and February 28, 2027.</li>
        <li><b>Tax.</b> HMRC normally treats individuals' crypto trading as investment, so Capital Gains Tax applies to each disposal, including swaps. Crypto firms report user data to HMRC under the Cryptoasset Reporting Framework from January 1, 2026.</li>
      </ul>`,
    sources: [
      src('FCA: crypto marketing to UK consumers', 'https://www.fca.org.uk/firms/cryptoassets/marketing-uk-consumers'),
      src('FCA FG24/1 (finfluencers)', 'https://www.fca.org.uk/publication/finalised-guidance/fg24-1.pdf'),
      src('SI 2026/102', 'https://www.legislation.gov.uk/uksi/2026/102/contents/made'),
      src('CMS on SI 2026/102', 'https://cms.law/en/gbr/regulatory-news/the-financial-services-and-markets-act-2000-cryptoassets-regulations-2026-102'),
      src('HMRC Cryptoassets Manual', 'https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto20250'),
    ],
  },
  {
    id: 'software',
    title: 'The software, its data and privacy',
    status: 'unsettled',
    body: `
      <ul>
        <li><b>No license file.</b> The code is public on GitHub but has no open-source license. By default that means all rights are reserved: GitHub's terms let others view and fork it on GitHub, but not much more. Whether to add a license, and which, is the owner's choice.</li>
        <li><b>Market data terms.</b> Paper Lab uses GeckoTerminal's free public API, and the public demo republishes recorded prices from it. We could not open GeckoTerminal's terms from our tools, so whether they allow republishing recorded data, and what attribution they require, is <b>unchecked</b>. The app and the Guide credit GeckoTerminal.</li>
        <li><b>Bundled software.</b> The Windows download includes a copy of Node.js, and the app includes TradingView's Lightweight Charts (license file included, credit shown in the Guide). Their license notices should travel with the download.</li>
        <li><b>Privacy.</b> The app collects no personal data and has no accounts. The demo is hosted on GitHub Pages, and GitHub may log visitors' IP addresses under its own privacy statement.</li>
      </ul>`,
    sources: [
      src('GitHub: licensing a repository', 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository'),
      src('GeckoTerminal terms', 'https://www.geckoterminal.com/terms-conditions'),
      src('GitHub privacy statement', 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement'),
    ],
  },
  {
    id: 'questions',
    title: 'Questions for a lawyer',
    body: `
      <ol class="legal-questions">
        <li>Could the "Hot now" list with hit rates be treated as investment advice, or as a commodity trading adviser's advice, in the US? What wording or design keeps it clearly impersonal?</li>
        <li>Is the public demo a "financial promotion" to UK viewers? Would a free, non-commercial project be "in the course of business"? Should the demo geoblock the UK, or add a UK notice?</li>
        <li>Under MiCA, does publishing the same information to everyone stay outside "personalised" advice, given ESMA's broad reading?</li>
        <li>If anyone uses Paper Lab's information to trade real money on behalf of someone else, what registration, agreement or disclosure does that need?</li>
        <li>Do the current disclaimers ("pretend money", "not advice", sample sizes shown) meet FTC expectations for hypothetical results?</li>
        <li>Do GeckoTerminal's API terms allow the demo's republished data, and do they require more attribution?</li>
        <li>Which open-source license, if any, should the code carry, and do the Node.js and Lightweight Charts notices need to ship differently?</li>
        <li>State law: are there state money transmission, securities or consumer protection rules worth checking? This page does not cover states.</li>
      </ol>`,
  },
];

/** @param {HTMLElement} view */
export function legalPage(view) {
  const toc = SECTIONS.map((s) => `<li><a href="#/legal/${s.id}">${s.title}</a></li>`).join('');
  const chip = (/** @type {Status|undefined} */ st) => (st ? ` <span class="legal-status ${st}" title="${STATUS[st].tip}">${STATUS[st].label}</span>` : '');
  const sections = SECTIONS.map(
    (s) => `<section class="legal-section" id="${s.id}">
      <h2>${s.title}${chip(s.status)}</h2>
      ${s.body}
      ${s.sources?.length ? `<p class="legal-sources">Sources: ${s.sources.join(' · ')}</p>` : ''}
    </section>`,
  ).join('');
  view.innerHTML = `<div class="page guide legal">
    <div class="page-head"><h1>Legal</h1><span class="muted">For a lawyer reviewing Paper Lab · checked ${CHECKED}</span></div>
    <p class="legal-note"><b>General information, not legal advice.</b> Written in plain language to help a lawyer get oriented quickly. Crypto rules change fast; check each point against the linked sources before relying on it. Several official pages could not be opened from our tools, so some points rest on law-firm and news summaries of them. Covers US federal law, the EU and the UK, not US states.</p>
    <p class="legal-legend"><span class="legal-status settled">Settled</span> long-standing <span class="legal-status changing">Changing</span> moved recently <span class="legal-status unsettled">Unsettled</span> no clear answer yet</p>
    <ol class="legal-toc">${toc}</ol>
    ${sections}
  </div>`;
}
