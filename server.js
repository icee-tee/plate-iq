'use strict';
const express      = require('express');
const path         = require('path');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const Anthropic    = require('@anthropic-ai/sdk');
const nodemailer   = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'plateiq-admin-2026';

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const mailer = (process.env.SMTP_HOST && process.env.SMTP_USER)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT)||587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

// ── Middleware ────────────────────────────────────────────────────────────────
// Stripe webhook needs raw body — register before express.json
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────────────────
const pgPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pgPool) return console.warn('⚠  No DATABASE_URL');
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email              TEXT PRIMARY KEY,
      password_hash      TEXT NOT NULL,
      plan               TEXT DEFAULT 'none',
      stripe_customer_id TEXT,
      stripe_sub_id      TEXT,
      plan_status        TEXT DEFAULT 'inactive',
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      postcode    TEXT,
      cuisine     TEXT,
      platforms   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS credentials (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      platform      TEXT NOT NULL,
      login_email   TEXT,
      login_password TEXT,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS weekly_data (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      week_ending   DATE NOT NULL,
      orders        INTEGER,
      revenue       NUMERIC(10,2),
      aov           NUMERIC(8,2),
      rating        NUMERIC(3,2),
      new_reviews   INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(restaurant_id, week_ending)
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      week_ending   DATE NOT NULL,
      report_data   JSONB NOT NULL,
      emailed_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(restaurant_id, week_ending)
    )
  `);
  console.log('✅ DB ready');
}
initDb().catch(console.error);

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function findUser(email) {
  if (!pgPool) return null;
  const r = await pgPool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
  return r.rows[0] || null;
}
async function createUser(email, password) {
  if (!pgPool) return null;
  const hash = await bcrypt.hash(password, 10);
  await pgPool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [email.toLowerCase(), hash]
  );
  return findUser(email);
}
async function createSession(email) {
  if (!pgPool) return uuid();
  const token = uuid();
  const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pgPool.query('INSERT INTO sessions (token, email, expires_at) VALUES ($1,$2,$3)', [token, email.toLowerCase(), exp]);
  return token;
}
async function getSession(token) {
  if (!token || !pgPool) return null;
  const r = await pgPool.query('SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()', [token]);
  return r.rows[0] || null;
}
async function requireAuth(req, res, next) {
  const sess = await getSession(req.headers['x-session-token']);
  if (!sess) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  req.userEmail = sess.email;
  const user = await findUser(sess.email);
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  next();
}

// ── Restaurant helpers ────────────────────────────────────────────────────────
async function getUserRestaurant(email) {
  if (!pgPool) return null;
  const r = await pgPool.query('SELECT * FROM restaurants WHERE user_email=$1 LIMIT 1', [email]);
  return r.rows[0] || null;
}
async function getRestaurantHistory(restaurantId) {
  if (!pgPool) return [];
  const r = await pgPool.query(
    `SELECT wd.*, rep.report_data FROM weekly_data wd
     LEFT JOIN reports rep ON rep.restaurant_id=wd.restaurant_id AND rep.week_ending=wd.week_ending
     WHERE wd.restaurant_id=$1 ORDER BY wd.week_ending DESC LIMIT 20`,
    [restaurantId]
  );
  return r.rows;
}

// ── AI report generation ──────────────────────────────────────────────────────
async function generateReport(restaurant, weekData, history) {
  const trend = history.length >= 2
    ? (weekData.orders > history[1].orders ? 'up' : weekData.orders < history[1].orders ? 'down' : 'flat')
    : 'unknown';
  const prevWeek = history[1] || null;
  const orderDelta = prevWeek ? weekData.orders - prevWeek.orders : 0;
  const revDelta   = prevWeek ? (weekData.revenue - prevWeek.revenue).toFixed(2) : 0;

  const historyStr = history.slice(0, 8).map(h =>
    `Week ending ${h.week_ending}: ${h.orders} orders, £${h.revenue} revenue, AOV £${h.aov}, rating ${h.rating}`
  ).join('\n');

  const prompt = `You are a specialist in restaurant delivery platform optimisation — Uber Eats, Just Eat, and Deliveroo in the UK.

Generate a detailed weekly performance report for this restaurant.

RESTAURANT:
Name: ${restaurant.name}
Postcode: ${restaurant.postcode || 'not provided'}
Cuisine: ${restaurant.cuisine || 'not specified'}
Platforms: ${restaurant.platforms || 'not specified'}

THIS WEEK'S DATA (week ending ${weekData.week_ending}):
- Orders: ${weekData.orders}
- Revenue: £${weekData.revenue}
- Average order value: £${weekData.aov}
- Current rating: ${weekData.rating}
- New reviews this week: ${weekData.new_reviews || 0}
- Notes from our team: ${weekData.notes || 'none'}

TREND vs LAST WEEK:
- Orders: ${orderDelta >= 0 ? '+' : ''}${orderDelta} (${trend})
- Revenue: ${revDelta >= 0 ? '+' : ''}£${Math.abs(revDelta)}

HISTORICAL DATA (last 8 weeks):
${historyStr || 'First week — no historical data yet'}

Based on this data, generate a specific, insightful weekly report. Reference the actual numbers. Be direct and honest — if performance is down, say why and what to do. If it's up, say what's working and how to sustain it.

Respond ONLY with valid JSON — no markdown, no preamble:
{
  "headline": "<one punchy sentence summarising this week — e.g. 'Strong Friday performance, but midweek gap is widening'>",
  "summary": "<2-3 sentences of honest analysis referencing the actual numbers and trend>",
  "scorecard": {
    "orders": { "value": ${weekData.orders}, "delta": ${orderDelta}, "trend": "${trend}" },
    "revenue": { "value": ${weekData.revenue}, "delta": ${revDelta}, "trend": "${trend}" },
    "aov": { "value": ${weekData.aov}, "delta": ${prevWeek ? (weekData.aov - prevWeek.aov).toFixed(2) : 0} },
    "rating": { "value": ${weekData.rating}, "delta": ${prevWeek ? (weekData.rating - prevWeek.rating).toFixed(2) : 0} }
  },
  "insights": [
    {
      "type": "critical|warning|positive",
      "icon": "<emoji>",
      "title": "<specific insight title — reference actual numbers>",
      "body": "<2-3 sentences — specific to their cuisine, postcode area, platform. What does this number mean? Why?>"
    }
  ],
  "thisWeekActions": [
    "<specific, concrete action — not generic advice. Reference their actual situation.>",
    "<specific action>",
    "<specific action>"
  ],
  "longerTermActions": [
    "<action for next 2-4 weeks>",
    "<action for next 2-4 weeks>"
  ],
  "ratingAnalysis": "<one paragraph on their rating — is 4.X good for their cuisine in their area? What does it mean for platform ranking? What should they do?>",
  "weeklyInsight": "<one specific insight about their trading pattern based on the trend — e.g. if orders are consistently low on certain days, call it out>"
}

The insights array must have EXACTLY 3 items. Make them specific to the actual data — not generic delivery advice.`;

  if (!anthropic) return generateFallbackReport(restaurant, weekData, trend, orderDelta);

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = msg.content[0]?.text?.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

function generateFallbackReport(restaurant, weekData, trend, orderDelta) {
  return {
    headline: `${weekData.orders} orders this week — ${trend === 'up' ? 'up ' + orderDelta + ' vs last week' : trend === 'down' ? 'down ' + Math.abs(orderDelta) + ' vs last week' : 'holding steady'}`,
    summary: `${restaurant.name} generated ${weekData.orders} orders and £${weekData.revenue} revenue this week with an average order value of £${weekData.aov}. Rating is holding at ${weekData.rating}.`,
    scorecard: {
      orders:  { value: weekData.orders,  delta: orderDelta, trend },
      revenue: { value: weekData.revenue, delta: 0, trend },
      aov:     { value: weekData.aov,     delta: 0 },
      rating:  { value: weekData.rating,  delta: 0 }
    },
    insights: [
      { type: 'positive', icon: '📊', title: 'Weekly data recorded', body: 'Your performance data has been logged for this week. Connect an Anthropic API key to generate full AI analysis.' },
      { type: 'warning',  icon: '📸', title: 'Photo coverage review recommended', body: 'Ensure all high-margin items have high-quality photos — this is the single biggest lever on delivery platforms.' },
      { type: 'positive', icon: '⭐', title: `Rating at ${weekData.rating}`, body: `A ${weekData.rating} rating ${weekData.rating >= 4.5 ? 'is strong' : weekData.rating >= 4.0 ? 'is decent but there is room to improve' : 'needs attention — below 4.0 significantly impacts platform ranking'}.` }
    ],
    thisWeekActions: ['Review and respond to all new reviews this week', 'Check that your menu pricing is consistent across all platforms', 'Ensure your top 5 items have high-quality photos'],
    longerTermActions: ['Plan a promotional offer for your slowest trading day', 'Review your menu category structure for clarity'],
    ratingAnalysis: `A rating of ${weekData.rating} on delivery platforms ${weekData.rating >= 4.5 ? 'is excellent and puts you in the top tier for search placement' : weekData.rating >= 4.2 ? 'is solid but upgrading to 4.5+ would unlock significantly better platform visibility' : 'needs improvement — platforms deprioritise restaurants below 4.0 in search results'}.`,
    weeklyInsight: 'Continue logging weekly data to build a trend picture — insights improve significantly after 4+ weeks of data.'
  };
}

// ── Email helper ──────────────────────────────────────────────────────────────
async function sendReportEmail(toEmail, restaurantName, weekEnding, reportData) {
  if (!mailer) return;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'reports@plateiq.co.uk',
      to: toEmail,
      subject: `Your PlateIQ weekly report — ${restaurantName} — w/e ${weekEnding}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#1a1a1a;">${reportData.headline}</h2>
          <p style="color:#6b6b6b;">${reportData.summary}</p>
          <div style="background:#fef3dc;border-radius:8px;padding:16px;margin:16px 0;">
            <strong>This week's numbers:</strong><br>
            Orders: ${reportData.scorecard.orders.value} &nbsp;|&nbsp;
            Revenue: £${reportData.scorecard.revenue.value} &nbsp;|&nbsp;
            AOV: £${reportData.scorecard.aov.value} &nbsp;|&nbsp;
            Rating: ${reportData.scorecard.rating.value}
          </div>
          <p><strong>This week's actions:</strong></p>
          <ul>${(reportData.thisWeekActions||[]).map(a => `<li>${a}</li>`).join('')}</ul>
          <p style="margin-top:24px;"><a href="${BASE}/dashboard" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View full report →</a></p>
        </div>
      `
    });
    console.log(`[email] Report sent to ${toEmail}`);
  } catch(e) { console.warn('[email] Failed:', e.message); }
}

// ── Stripe webhook ────────────────────────────────────────────────────────────
async function handleStripeWebhook(req, res) {
  if (!stripe) return res.json({ received: true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send(`Webhook error: ${e.message}`); }

  if (event.type === 'checkout.session.completed') {
    const sess = event.data.object;
    const email = sess.customer_email || sess.metadata?.email;
    const plan  = sess.metadata?.plan;
    if (email && plan && pgPool) {
      await pgPool.query(
        'UPDATE users SET plan=$1, plan_status=$2, stripe_customer_id=$3, stripe_sub_id=$4 WHERE email=$5',
        [plan, 'active', sess.customer, sess.subscription, email.toLowerCase()]
      );
      console.log(`[stripe] ${email} subscribed to ${plan}`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    if (pgPool) {
      await pgPool.query('UPDATE users SET plan_status=$1 WHERE stripe_sub_id=$2', ['cancelled', sub.id]);
    }
  }
  res.json({ received: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Free snapshot helpers ─────────────────────────────────────────────────────
async function fetchPageContent(url) {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlateIQ/1.0)' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
      .replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
      .replace(/\s{2,}/g,' ').trim().slice(0, 3000);
    return clean || null;
  } catch(e) { console.warn('[fetch-page]', e.message); return null; }
}

async function runFreeSnapshot(input, pageContent) {
  if (!anthropic) return generateDemoSnapshot(input);

  const scrapedSection = pageContent
    ? `SCRAPED FROM PUBLIC LISTING:\n---\n${pageContent}\n---\nAnalyse ONLY what is present. Do not invent ratings, order volumes, or competitor names.`
    : `SCRAPE RESULT: Could not read the page (likely JavaScript-rendered). Do NOT invent details. Only infer from name, postcode, and cuisine.`;

  const prompt = `You are a UK restaurant delivery specialist. A restaurant wants a free snapshot. Be honest — only reference things you actually see or can genuinely infer.

RESTAURANT: ${input.restaurantName} | Postcode: ${input.postcode||'unknown'} | Cuisine: ${input.cuisine||'not specified'} | Platforms: ${input.platforms||'not specified'} | Exclusive: ${input.exclusive==='yes'?'Yes':'No'}

${scrapedSection}

STRICT RULES:
- Never invent ratings, competitor names, or order volumes
- If you saw menu categories in the scrape, name them specifically
- If you saw delivery time or minimum order, cite those exact values
- If scrape failed, still give 3 useful honest inferences from cuisine + postcode alone
- Do not say "I cannot see" — just give what you CAN say

Respond ONLY with valid JSON, no markdown:
{
  "scrapedSuccessfully": <true|false>,
  "whatWeFound": "<one honest sentence about what data we got>",
  "score": <integer 40-79>,
  "scoreLabel": "<3-5 words>",
  "scoreSub": "<one sentence referencing only real observations>",
  "freeInsights": [
    { "type": "critical|warning|positive", "icon": "<emoji>", "title": "<specific headline>", "body": "<2-3 sentences, concrete and useful>", "impact": "<honest estimate or empty string>" },
    { "type": "critical|warning|positive", "icon": "<emoji>", "title": "<specific headline>", "body": "<2-3 sentences>", "impact": "" },
    { "type": "critical|warning|positive", "icon": "<emoji>", "title": "<specific headline>", "body": "<2-3 sentences>", "impact": "" }
  ],
  "lockedItems": [
    {"icon": "📊", "title": "Your actual weekly order volume and revenue"},
    {"icon": "📈", "title": "Your real conversion rate vs area average"},
    {"icon": "🏆", "title": "How you rank against competitors in your postcode"},
    {"icon": "⭐", "title": "Review response rate and sentiment analysis"},
    {"icon": "⚡", "title": "Your single highest-impact change this week"}
  ]
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = msg.content[0]?.text?.replace(/```json|```/g,'').trim();
  return JSON.parse(text);
}

function generateDemoSnapshot(input) {
  return {
    scrapedSuccessfully: false,
    whatWeFound: `We identified ${input.restaurantName} as a ${input.cuisine||'restaurant'} in ${input.postcode||'your area'}.`,
    score: 62, scoreLabel: 'Room to improve',
    scoreSub: 'Based on what we could see, there are clear opportunities to increase your order volume.',
    freeInsights: [
      { type:'warning', icon:'📸', title:'Photo coverage is the #1 ranking factor on Uber Eats', body:`${input.cuisine||'Restaurants'} in ${input.postcode||'your area'} with full photo coverage get 40-60% more clicks. Items without photos are effectively invisible on mobile.`, impact:'Potential +15-25 orders/week' },
      { type:'critical', icon:'📂', title:'Menu structure directly affects your search placement', body:'How you name and group your categories affects how the algorithm surfaces you. Generic names like "Mains" or "Extras" consistently underperform specific category names.', impact:'' },
      { type:'positive', icon:'⭐', title:'Review response rate affects your platform ranking', body:`Responding to reviews within 24 hours signals to ${input.platforms||'the platform'} that you\'re an engaged partner — this directly influences your search position.`, impact:'Protects existing ranking' }
    ],
    lockedItems: [
      {icon:'📊',title:'Your actual weekly order volume and revenue'},
      {icon:'📈',title:'Your real conversion rate vs area average'},
      {icon:'🏆',title:'How you rank against competitors in your postcode'},
      {icon:'⭐',title:'Review response rate and sentiment analysis'},
      {icon:'⚡',title:'Your single highest-impact change this week'}
    ]
  };
}

// POST /api/analyse — free public snapshot (no auth required)
app.post('/api/analyse', async (req, res) => {
  const { restaurantName, postcode, city, cuisine, platforms, url, exclusive, email } = req.body;
  if (!restaurantName) return res.status(400).json({ ok: false, error: 'Restaurant name is required.' });
  try {
    console.log(`[snapshot] ${restaurantName}, ${postcode||city}`);
    const pageContent = url ? await fetchPageContent(url) : null;
    const report = await runFreeSnapshot({ restaurantName, postcode: postcode||city, cuisine, platforms, url, exclusive }, pageContent);
    res.json({ ok: true, report, restaurantName, postcode: postcode||city, cuisine, platforms, url, email });
  } catch(e) {
    console.error('[snapshot] error:', e.message);
    res.status(500).json({ ok: false, error: 'Analysis failed. Please try again.' });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  try {
    const existing = await findUser(email);
    if (existing) return res.status(409).json({ ok: false, error: 'Account already exists. Please sign in.' });
    await createUser(email, password);
    const token = await createSession(email);
    res.json({ ok: true, token });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'No account found with this email.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect password.' });
    const token = await createSession(email);
    res.json({ ok: true, token, plan: user.plan, planStatus: user.plan_status });
  } catch(e) { res.status(500).json({ ok: false, error: 'Login failed.' }); }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  const token = req.headers['x-session-token'];
  if (pgPool) await pgPool.query('DELETE FROM sessions WHERE token=$1', [token]);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = req.user;
  const restaurant = await getUserRestaurant(req.userEmail);
  res.json({ ok: true, email: user.email, plan: user.plan, planStatus: user.plan_status, restaurant });
});

// ── Stripe checkout ───────────────────────────────────────────────────────────
const PLAN_PRICES = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth:  process.env.STRIPE_PRICE_GROWTH,
  partner: process.env.STRIPE_PRICE_PARTNER
};

app.post('/api/checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(400).json({ ok: false, error: 'Stripe not configured.' });
  const { plan } = req.body;
  const priceId = PLAN_PRICES[plan];
  if (!priceId) return res.status(400).json({ ok: false, error: 'Invalid plan.' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: req.userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { email: req.userEmail, plan },
      success_url: `${BASE}/onboarding?plan=${plan}`,
      cancel_url: `${BASE}/dashboard`,
    });
    res.json({ ok: true, checkoutUrl: session.url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/cancel-subscription', requireAuth, async (req, res) => {
  if (!stripe || !req.user.stripe_sub_id) return res.status(400).json({ ok: false, error: 'No active subscription.' });
  try {
    await stripe.subscriptions.update(req.user.stripe_sub_id, { cancel_at_period_end: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Restaurant + credentials ──────────────────────────────────────────────────
app.post('/api/restaurant', requireAuth, async (req, res) => {
  const { name, postcode, cuisine, platforms } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Restaurant name required.' });
  if (!pgPool) return res.json({ ok: true, id: 'demo' });
  try {
    // Upsert — one restaurant per user for now
    const existing = await getUserRestaurant(req.userEmail);
    let id;
    if (existing) {
      await pgPool.query(
        'UPDATE restaurants SET name=$1, postcode=$2, cuisine=$3, platforms=$4 WHERE id=$5',
        [name, postcode, cuisine, platforms, existing.id]
      );
      id = existing.id;
    } else {
      const r = await pgPool.query(
        'INSERT INTO restaurants (user_email, name, postcode, cuisine, platforms) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [req.userEmail, name, postcode, cuisine, platforms]
      );
      id = r.rows[0].id;
    }
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/credentials', requireAuth, async (req, res) => {
  if (!pgPool) return res.json({ ok: true });
  const restaurant = await getUserRestaurant(req.userEmail);
  if (!restaurant) return res.status(400).json({ ok: false, error: 'No restaurant found.' });
  const { credentials } = req.body; // array of { platform, login_email, login_password, notes }
  try {
    // Delete existing and re-insert
    await pgPool.query('DELETE FROM credentials WHERE restaurant_id=$1', [restaurant.id]);
    for (const cred of (credentials || [])) {
      await pgPool.query(
        'INSERT INTO credentials (restaurant_id, platform, login_email, login_password, notes) VALUES ($1,$2,$3,$4,$5)',
        [restaurant.id, cred.platform, cred.login_email, cred.login_password, cred.notes || null]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Dashboard data ────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const restaurant = await getUserRestaurant(req.userEmail);
    if (!restaurant) return res.json({ ok: true, restaurant: null, history: [], latestReport: null });
    const history = await getRestaurantHistory(restaurant.id);
    const latestReport = history[0]?.report_data || null;
    res.json({ ok: true, restaurant, history, latestReport });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Report by ID ──────────────────────────────────────────────────────────────
app.get('/api/report/:weekEnding', requireAuth, async (req, res) => {
  if (!pgPool) return res.status(404).json({ ok: false });
  const restaurant = await getUserRestaurant(req.userEmail);
  if (!restaurant) return res.status(404).json({ ok: false });
  const r = await pgPool.query(
    'SELECT * FROM reports WHERE restaurant_id=$1 AND week_ending=$2',
    [restaurant.id, req.params.weekEnding]
  );
  if (!r.rows[0]) return res.status(404).json({ ok: false });
  res.json({ ok: true, report: r.rows[0].report_data });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/clients — all clients with restaurant + plan info
app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ ok: true, clients: [] });
  const r = await pgPool.query(`
    SELECT u.email, u.plan, u.plan_status, u.created_at,
           rest.id as restaurant_id, rest.name, rest.postcode, rest.cuisine, rest.platforms,
           (SELECT COUNT(*) FROM weekly_data wd WHERE wd.restaurant_id = rest.id) as weeks_logged
    FROM users u
    LEFT JOIN restaurants rest ON rest.user_email = u.email
    ORDER BY u.created_at DESC
  `);
  res.json({ ok: true, clients: r.rows });
});

// GET /admin/client/:email — full client detail including credentials
app.get('/api/admin/client/:email', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ ok: true });
  const email = req.params.email;
  const user = await findUser(email);
  const restaurant = await getUserRestaurant(email);
  let credentials = [], history = [];
  if (restaurant) {
    const cr = await pgPool.query('SELECT * FROM credentials WHERE restaurant_id=$1', [restaurant.id]);
    credentials = cr.rows;
    history = await getRestaurantHistory(restaurant.id);
  }
  res.json({ ok: true, user, restaurant, credentials, history });
});

// POST /admin/weekly-data — enter weekly numbers for a client
app.post('/api/admin/weekly-data', requireAdmin, async (req, res) => {
  const { restaurantId, weekEnding, orders, revenue, aov, rating, newReviews, notes } = req.body;
  if (!restaurantId || !weekEnding) return res.status(400).json({ ok: false, error: 'restaurantId and weekEnding required.' });
  if (!pgPool) return res.json({ ok: true });
  try {
    await pgPool.query(`
      INSERT INTO weekly_data (restaurant_id, week_ending, orders, revenue, aov, rating, new_reviews, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (restaurant_id, week_ending) DO UPDATE SET
        orders=$3, revenue=$4, aov=$5, rating=$6, new_reviews=$7, notes=$8
    `, [restaurantId, weekEnding, orders, revenue, aov, rating, newReviews || 0, notes || null]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /admin/generate-report — generate AI report for a specific week
app.post('/api/admin/generate-report', requireAdmin, async (req, res) => {
  const { restaurantId, weekEnding } = req.body;
  if (!restaurantId || !weekEnding) return res.status(400).json({ ok: false, error: 'restaurantId and weekEnding required.' });
  if (!pgPool) return res.status(400).json({ ok: false, error: 'No DB.' });
  try {
    // Get restaurant
    const rr = await pgPool.query('SELECT * FROM restaurants WHERE id=$1', [restaurantId]);
    const restaurant = rr.rows[0];
    if (!restaurant) return res.status(404).json({ ok: false, error: 'Restaurant not found.' });

    // Get this week's data
    const wr = await pgPool.query('SELECT * FROM weekly_data WHERE restaurant_id=$1 AND week_ending=$2', [restaurantId, weekEnding]);
    const weekData = wr.rows[0];
    if (!weekData) return res.status(404).json({ ok: false, error: 'No weekly data found for this week. Enter data first.' });

    // Get history
    const history = await getRestaurantHistory(restaurantId);

    // Generate AI report
    console.log(`[admin] Generating report for ${restaurant.name} week ${weekEnding}`);
    const reportData = await generateReport(restaurant, weekData, history);

    // Save report
    await pgPool.query(`
      INSERT INTO reports (restaurant_id, week_ending, report_data)
      VALUES ($1,$2,$3)
      ON CONFLICT (restaurant_id, week_ending) DO UPDATE SET report_data=$3
    `, [restaurantId, weekEnding, JSON.stringify(reportData)]);

    // Send email if client has active plan
    const user = await findUser(restaurant.user_email);
    if (user?.plan_status === 'active') {
      await sendReportEmail(user.email, restaurant.name, weekEnding, reportData);
      await pgPool.query('UPDATE reports SET emailed_at=NOW() WHERE restaurant_id=$1 AND week_ending=$2', [restaurantId, weekEnding]);
    }

    res.json({ ok: true, report: reportData });
  } catch(e) {
    console.error('[admin] generate-report error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /admin/client/:email — delete account
app.delete('/api/admin/client/:email', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ ok: true });
  try {
    await pgPool.query('DELETE FROM users WHERE email=$1', [req.params.email]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /admin/stats — revenue overview
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if (!pgPool) return res.json({ ok: true, stats: {} });
  const r = await pgPool.query(`
    SELECT
      COUNT(*) FILTER (WHERE plan_status='active') as active_clients,
      COUNT(*) FILTER (WHERE plan='starter' AND plan_status='active') as starter_count,
      COUNT(*) FILTER (WHERE plan='growth'  AND plan_status='active') as growth_count,
      COUNT(*) FILTER (WHERE plan='partner' AND plan_status='active') as partner_count,
      COUNT(*) as total_users
    FROM users
  `);
  const s = r.rows[0];
  const mrr = (s.starter_count * 199) + (s.growth_count * 499) + (s.partner_count * 999);
  res.json({ ok: true, stats: { ...s, mrr } });
});

// ── Page routes ───────────────────────────────────────────────────────────────
const pages = ['dashboard', 'login', 'onboarding', 'account', 'admin', 'report', 'results'];
pages.forEach(p => app.get(`/${p}`, (req, res) => res.sendFile(path.join(__dirname, 'public', `${p}.html`))));

app.listen(PORT, () => console.log(`PlateIQ v2 running on port ${PORT}`));
