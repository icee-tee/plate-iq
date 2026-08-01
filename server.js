'use strict';
const express    = require('express');
const path       = require('path');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const { v4: uuid } = require('uuid');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────────────────
const pgPool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDb() {
  if (!pgPool) return console.warn('⚠ No DATABASE_URL — data will not persist');
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      email        TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      plan         TEXT DEFAULT 'free',
      created_at   TIMESTAMPTZ DEFAULT NOW()
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
    CREATE TABLE IF NOT EXISTS reports (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_email    TEXT,
      restaurant_name TEXT,
      city          TEXT,
      cuisine       TEXT,
      platforms     TEXT,
      restaurant_url TEXT,
      report_data   JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
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
  const exp   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pgPool.query(
    'INSERT INTO sessions (token, email, expires_at) VALUES ($1,$2,$3)',
    [token, email.toLowerCase(), exp]
  );
  return token;
}

async function getSession(token) {
  if (!token || !pgPool) return null;
  const r = await pgPool.query(
    'SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()',
    [token]
  );
  return r.rows[0] || null;
}

async function saveReport(email, data) {
  if (!pgPool) return null;
  const r = await pgPool.query(
    `INSERT INTO reports (user_email, restaurant_name, city, cuisine, platforms, restaurant_url, report_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [email?.toLowerCase() || null, data.restaurantName, data.city, data.cuisine,
     data.platforms, data.url, JSON.stringify(data.report)]
  );
  return r.rows[0]?.id;
}

async function getUserReports(email) {
  if (!pgPool) return [];
  const r = await pgPool.query(
    'SELECT id, restaurant_name, city, created_at, report_data FROM reports WHERE user_email=$1 ORDER BY created_at DESC',
    [email.toLowerCase()]
  );
  return r.rows;
}

// ── Homepage fetch ────────────────────────────────────────────────────────────
async function fetchPageContent(url) {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8000);
    const res  = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlateIQ/1.0)' }
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
      .replace(/\s{2,}/g, ' ').trim().slice(0, 3000);
    return clean || null;
  } catch(e) { return null; }
}

// ── Claude analysis ───────────────────────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function analyseRestaurant(input, pageContent) {
  if (!anthropic) return generateDemoReport(input);

  const platform = input.url?.includes('ubereats') ? 'Uber Eats'
    : input.url?.includes('just-eat') ? 'Just Eat'
    : input.url?.includes('deliveroo') ? 'Deliveroo'
    : 'delivery platform';

  const prompt = `You are a specialist in restaurant delivery platform optimisation — Uber Eats, Just Eat, and Deliveroo in the UK.

Analyse this restaurant's delivery presence and generate a detailed performance report.

RESTAURANT DETAILS:
Name: ${input.restaurantName}
City / area: ${input.city}
Cuisine: ${input.cuisine || 'not specified'}
Platforms they're on: ${input.platforms || 'not specified'}
Listing URL: ${input.url || 'not provided'}
Exclusive to one platform: ${input.exclusive === 'yes' ? 'Yes' : 'No — on multiple platforms'}

${pageContent ? `PAGE CONTENT (extracted from their listing URL):\n${pageContent}\n` : ''}

Based on this information, generate a comprehensive performance audit. Be specific to their cuisine type, city, and platform. Reference real platform mechanics.

Respond ONLY with valid JSON — no markdown, no preamble:
{
  "score": <integer 40-82>,
  "scoreLabel": "<3-5 word verdict>",
  "scoreSub": "<one sentence on what this score means for their order volume>",
  "dimensions": {
    "photoScore": <0-10>,
    "menuScore": <0-10>,
    "pricingScore": <0-10>,
    "visibilityScore": <0-10>,
    "reviewScore": <0-10>
  },
  "freeInsights": [
    {
      "type": "critical|warning|positive",
      "icon": "<emoji>",
      "title": "<specific, direct headline>",
      "body": "<2-3 sentences — specific to their cuisine, city, platform. Reference actual platform mechanics.>",
      "impact": "<realistic impact estimate e.g. '+12-18 orders/week'>"
    }
  ],
  "lockedInsights": [
    {
      "icon": "<emoji>",
      "title": "<teaser headline — intriguing but don't give the full answer>",
      "preview": "<one teaser sentence — hints at the finding without revealing it>"
    }
  ],
  "photoAudit": {
    "totalItems": <estimated integer>,
    "itemsWithPhotos": <estimated integer>,
    "missingPhotos": ["<item name>", "<item name>"],
    "priorityItem": "<the single most important item to photograph first>"
  },
  "weeklyPulse": {
    "totalOrders": <estimated weekly integer>,
    "avgOrderValue": <estimated float>,
    "trend": "up|flat|down",
    "trendPct": <integer>,
    "dayData": [
      {"day": "Mon", "orders": <int>},
      {"day": "Tue", "orders": <int>},
      {"day": "Wed", "orders": <int>},
      {"day": "Thu", "orders": <int>},
      {"day": "Fri", "orders": <int>},
      {"day": "Sat", "orders": <int>},
      {"day": "Sun", "orders": <int>}
    ],
    "insight": "<one specific insight about their trading pattern>"
  },
  "competitors": [
    {"rank": 1, "name": "<realistic competitor name for their area>", "score": <int 80-97>, "photos": "<X/Y>", "rating": "<float>", "isYou": false},
    {"rank": 2, "name": "<competitor>", "score": <int 75-90>, "photos": "<X/Y>", "rating": "<float>", "isYou": false},
    {"rank": 3, "name": "<competitor>", "score": <int 65-80>, "photos": "<X/Y>", "rating": "<float>", "isYou": false},
    {"rank": 4, "name": "${input.restaurantName}", "score": <same as top-level score>, "photos": "<estimated X/Y>", "rating": "<estimated rating>", "isYou": true},
    {"rank": 5, "name": "<competitor>", "score": <int 50-70>, "photos": "<X/Y>", "rating": "<float>", "isYou": false}
  ],
  "actionPlan": {
    "thisWeek": ["<specific action>", "<specific action>", "<specific action>"],
    "twoWeeks": ["<specific action>", "<specific action>", "<specific action>"],
    "thisMonth": ["<specific action>"]
  },
  "competitorGap": "<one sentence on the main gap between this restaurant and the #1 in their area>"
}

The freeInsights array must have EXACTLY 3 items.
The lockedInsights array must have EXACTLY 5 items — these are blurred/locked behind the paid plan.
Make estimates realistic — don't be overly optimistic. A restaurant with issues should score 45-65.`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = msg.content[0]?.text?.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

function generateDemoReport(input) {
  return {
    score: 71, scoreLabel: 'Good foundations',
    scoreSub: `${input.restaurantName} has solid basics but critical gaps in photo coverage are limiting your reach.`,
    dimensions: { photoScore: 4.2, menuScore: 6.8, pricingScore: 8.1, visibilityScore: 7.0, reviewScore: 8.4 },
    freeInsights: [
      { type:'critical', icon:'📸', title:'Only 8 of 24 menu items have a photo', body:`Items without photos on Uber Eats receive 63% fewer clicks. Your highest-margin category has zero photos.`, impact:'+18–24 orders/week if resolved' },
      { type:'warning', icon:'📂', title:`Menu category "Extras" is suppressing basket size`, body:`14 items grouped under one catch-all category. Split into Sides, Breads, and Drinks to surface items customers want.`, impact:'Avg basket up £2.40–£3.80' },
      { type:'positive', icon:'⭐', title:'Review response rate in top 15% for your area', body:`91% of reviews answered in 30 days. Uber Eats rewards this with improved search placement. Keep it up.`, impact:'Protects current ranking' }
    ],
    lockedInsights: [
      { icon:'💰', title:'Your pricing strategy has a hidden leak', preview:'We found a specific pricing issue that\'s likely costing you 8–12 orders every week...' },
      { icon:'🏆', title:'The #1 restaurant in your area does one thing differently', preview:'It\'s not what you\'d expect — and it\'s something you can replicate in under an hour...' },
      { icon:'📢', title:'Two promotional opportunities your competitors are missing', preview:'There are two gaps in the local market right now that you could fill this week...' },
      { icon:'🔄', title:'Cross-platform inconsistency is hurting your algorithm ranking', preview:'Your listings don\'t match across platforms — here\'s what that\'s costing you...' },
      { icon:'⚡', title:'The single highest-impact change you can make today', preview:'One change, 15 minutes, estimated +14 orders in the first week...' }
    ],
    photoAudit: { totalItems: 24, itemsWithPhotos: 8, missingPhotos: ['Chicken Biryani','Lamb Biryani','Vegetable Korma','Dal Makhani','Peshwari Naan'], priorityItem: 'Chicken Biryani' },
    weeklyPulse: {
      totalOrders: 312, avgOrderValue: 24.30, trend: 'up', trendPct: 8,
      dayData: [
        {day:'Mon',orders:28},{day:'Tue',orders:32},{day:'Wed',orders:38},
        {day:'Thu',orders:46},{day:'Fri',orders:82},{day:'Sat',orders:98},{day:'Sun',orders:56}
      ],
      insight: 'Your Monday–Wednesday volume is 34% below the area average. A midweek bundle deal could close this gap.'
    },
    competitors: [
      {rank:1,name:'Zouk',score:94,photos:'32/32',rating:'4.9',isYou:false},
      {rank:2,name:'Mughli',score:88,photos:'28/28',rating:'4.8',isYou:false},
      {rank:3,name:'Bundobust',score:79,photos:'19/26',rating:'4.7',isYou:false},
      {rank:4,name:input.restaurantName,score:71,photos:'8/24',rating:'4.6',isYou:true},
      {rank:5,name:"Akbar's",score:68,photos:'12/22',rating:'4.5',isYou:false}
    ],
    actionPlan: {
      thisWeek: ['Upload photos for Chicken Biryani, Lamb Biryani, and Vegetable Korma','Respond to 3 unanswered reviews from this week','Create a Midweek Meal Deal bundle — run Tue & Wed'],
      twoWeeks: ['Split "Extras" into Sides, Breads, and Drinks','Add descriptions to your 8 highest-price mains','Fix pricing discrepancy between Uber Eats and Just Eat listings'],
      thisMonth: ['Plan a seasonal promotional menu for the upcoming peak period']
    },
    competitorGap: 'Zouk leads primarily through 100% photo coverage and a £3 lower minimum order — both fixable in under a week.'
  };
}

// ── API Routes ────────────────────────────────────────────────────────────────

// POST /api/analyse — main analysis endpoint
app.post('/api/analyse', async (req, res) => {
  const { restaurantName, city, cuisine, platforms, url, exclusive } = req.body;
  if (!restaurantName || !city) return res.status(400).json({ ok: false, error: 'Restaurant name and city are required.' });

  try {
    console.log(`[analyse] ${restaurantName}, ${city}`);
    const pageContent = url ? await fetchPageContent(url) : null;
    if (pageContent) console.log(`[analyse] fetched ${pageContent.length} chars from ${url}`);
    const report = await analyseRestaurant({ restaurantName, city, cuisine, platforms, url, exclusive }, pageContent);
    res.json({ ok: true, report, restaurantName, city, cuisine, platforms, url });
  } catch(e) {
    console.error('[analyse] error:', e.message);
    res.status(500).json({ ok: false, error: 'Analysis failed. Please try again.' });
  }
});

// POST /api/register — create account + save report
app.post('/api/register', async (req, res) => {
  const { email, password, reportData } = req.body;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });

  try {
    const existing = await findUser(email);
    if (existing) return res.status(409).json({ ok: false, error: 'An account with this email already exists. Please sign in.' });

    await createUser(email, password);
    const token = await createSession(email);
    let reportId = null;
    if (reportData) reportId = await saveReport(email, reportData);
    res.json({ ok: true, token, reportId });
  } catch(e) {
    console.error('[register] error:', e.message);
    res.status(500).json({ ok: false, error: 'Could not create account. Please try again.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await findUser(email);
    if (!user) return res.status(401).json({ ok: false, error: 'No account found with this email.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Incorrect password.' });
    const token = await createSession(email);
    const reports = await getUserReports(email);
    res.json({ ok: true, token, email: user.email, plan: user.plan, reports });
  } catch(e) {
    res.status(500).json({ ok: false, error: 'Login failed.' });
  }
});

// POST /api/save-report — save report for logged in user
app.post('/api/save-report', async (req, res) => {
  const token = req.headers['x-session-token'];
  const sess  = await getSession(token);
  if (!sess) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  try {
    const id = await saveReport(sess.email, req.body);
    res.json({ ok: true, reportId: id });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/reports — get all reports for logged in user
app.get('/api/reports', async (req, res) => {
  const token = req.headers['x-session-token'];
  const sess  = await getSession(token);
  if (!sess) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  const reports = await getUserReports(sess.email);
  res.json({ ok: true, reports });
});

// GET /api/report/:id — get single report
app.get('/api/report/:id', async (req, res) => {
  const token = req.headers['x-session-token'];
  const sess  = await getSession(token);
  if (!sess) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  if (!pgPool) return res.status(404).json({ ok: false });
  const r = await pgPool.query(
    'SELECT * FROM reports WHERE id=$1 AND user_email=$2',
    [req.params.id, sess.email]
  );
  if (!r.rows[0]) return res.status(404).json({ ok: false });
  res.json({ ok: true, report: r.rows[0] });
});

// GET /api/me
app.get('/api/me', async (req, res) => {
  const token = req.headers['x-session-token'];
  const sess  = await getSession(token);
  if (!sess) return res.status(401).json({ ok: false });
  const user = await findUser(sess.email);
  res.json({ ok: true, email: user?.email, plan: user?.plan || 'free' });
});

// Serve HTML pages
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.listen(PORT, () => console.log(`PlateIQ running on port ${PORT}`));
