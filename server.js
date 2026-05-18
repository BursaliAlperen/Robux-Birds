require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_COLLECTION = 'users';
const TASKS_COLLECTION = 'socialTasks';
const WITHDRAWALS_COLLECTION = 'withdrawals';
const APP_META_COLLECTION = 'appMeta';
const CONFIG_COLLECTION = 'config';
const ADMIN_USER_IDS = String(process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean);
const DAILY_ROBUX_LIMIT = 50;
const ENERGY_DURATION_MS = 16200 * 1000; // 4.5 hours
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 840000); // 14 minutes
const KEEP_ALIVE_URL = String(process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const BIRD_DB = [
  { id: 'baby', name_TR: 'Baby Kuş 🐤', name_EN: 'Baby Bird 🐤', cost: 1000, prod: 60, color: 'text-yellow-300', icon: '🐤', desc_TR: 'Sıcak kanlı başlangıç kuşu.', desc_EN: 'Warm-blooded starter bird.' },
  { id: 'owl', name_TR: 'Bilge Baykuş 🦉', name_EN: 'Wise Owl 🦉', cost: 5000, prod: 350, color: 'text-amber-500', icon: '🦉', desc_TR: 'Gece boyu durmaksızın üretir.', desc_EN: 'Produces eggs all night long.' },
  { id: 'swan', name_TR: 'Asil Kuğu 🦢', name_EN: 'Noble Swan 🦢', cost: 25000, prod: 1800, color: 'text-slate-100', icon: '🦢', desc_TR: 'Zarafetiyle zenginlik saçar.', desc_EN: 'Scatters wealth with grace.' },
  { id: 'phoenix', name_TR: 'Anka Kuşu 🐦‍🔥', name_EN: 'Phoenix 🐦‍🔥', cost: 100000, prod: 8500, color: 'text-red-500', icon: '🐦‍🔥', desc_TR: 'Küllerinden efsane kazançlar doğurur.', desc_EN: 'Brings legendary wealth from its ashes.' }
];

const DEFAULT_SOCIAL_TASKS = [
  { title_TR: 'YouTube Kanalına Abone Ol', title_EN: 'Subscribe to YouTube Channel', reward: '750 S', link: 'https://youtube.com', icon: 'fa-youtube text-red-500' },
  { title_TR: 'Telegram Grubuna Katıl', title_EN: 'Join Telegram Group', reward: '500 S', link: 'https://t.me', icon: 'fa-telegram text-blue-400' }
];

function parseFirebaseCredentials() {
  const raw = process.env.FIREBASE_CREDENTIALS;
  if (!raw || raw.trim() === '{}' || raw.includes('YOUR_FIREBASE_SERVICE_ACCOUNT_JSON')) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (err) {
      throw new Error('FIREBASE_CREDENTIALS must be a service-account JSON string or base64 encoded JSON.');
    }
  }
}

let db = null;
let memoryMode = false;
const memoryStore = {
  users: new Map(),
  socialTasks: new Map(DEFAULT_SOCIAL_TASKS.map((task, index) => [`default-${index + 1}`, { ...task, id: `default-${index + 1}` }])),
  withdrawals: new Map(),
  appMeta: new Map(),
  config: new Map()
};

function initFirebase() {
  const credentials = parseFirebaseCredentials();

  if (credentials) {
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
    db = admin.firestore();
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    db = admin.firestore();
    return;
  }

  memoryMode = true;
  console.warn('Firebase credentials are missing; using in-memory storage for local development. Set FIREBASE_CREDENTIALS in .env for Firestore.');
}

initFirebase();

function startKeepAlivePing() {
  if (!KEEP_ALIVE_URL) {
    console.log('Keep-alive ping disabled: set KEEP_ALIVE_URL or RENDER_EXTERNAL_URL to enable it.');
    return;
  }

  const pingUrl = `${KEEP_ALIVE_URL}/health`;
  const ping = async () => {
    try {
      const response = await fetch(pingUrl);
      if (!response.ok) console.warn(`Keep-alive ping returned ${response.status} for ${pingUrl}`);
    } catch (err) {
      console.warn(`Keep-alive ping failed for ${pingUrl}:`, err.message);
    }
  };

  setInterval(ping, KEEP_ALIVE_INTERVAL_MS).unref();
  setTimeout(ping, 10000).unref();
  console.log(`Keep-alive ping enabled for ${pingUrl} every ${Math.round(KEEP_ALIVE_INTERVAL_MS / 60000)} minutes.`);
}

function isAdminUser(userId) {
  return ADMIN_USER_IDS.includes(String(userId || '').trim().toLowerCase());
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sessionTokenFrom(req) {
  const auth = String(req.header('authorization') || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.header('x-session-token') || '').trim();
}

async function bootstrapDataStore() {
  const timestamp = now();
  const metaDoc = {
    initializedAt: timestamp,
    updatedAt: timestamp,
    collections: [USERS_COLLECTION, TASKS_COLLECTION, WITHDRAWALS_COLLECTION, APP_META_COLLECTION, CONFIG_COLLECTION],
    securityModel: 'server-only-firebase-admin'
  };
  const configDoc = { birds: BIRD_DB, dailyRobuxLimit: DAILY_ROBUX_LIMIT, energyDurationMs: ENERGY_DURATION_MS, updatedAt: timestamp };
  const collectionSchemas = {
    [USERS_COLLECTION]: { systemDoc: true, purpose: 'Player profiles and balances are auto-created on signup.', updatedAt: timestamp },
    [WITHDRAWALS_COLLECTION]: { systemDoc: true, purpose: 'Withdrawal queue documents are auto-created on request.', updatedAt: timestamp }
  };

  if (memoryMode) {
    memoryStore.appMeta.set('bootstrap', metaDoc);
    memoryStore.config.set('game', configDoc);
    memoryStore.users.set('_schema', collectionSchemas[USERS_COLLECTION]);
    memoryStore.withdrawals.set('_schema', collectionSchemas[WITHDRAWALS_COLLECTION]);
    DEFAULT_SOCIAL_TASKS.forEach((task, index) => {
      const id = `default-${index + 1}`;
      if (!memoryStore.socialTasks.has(id)) memoryStore.socialTasks.set(id, { ...task, id, systemSeed: true, createdAt: timestamp });
    });
    return;
  }

  await db.collection(APP_META_COLLECTION).doc('bootstrap').set(metaDoc, { merge: true });
  await db.collection(CONFIG_COLLECTION).doc('game').set(configDoc, { merge: true });
  await db.collection(USERS_COLLECTION).doc('_schema').set(collectionSchemas[USERS_COLLECTION], { merge: true });
  await db.collection(WITHDRAWALS_COLLECTION).doc('_schema').set(collectionSchemas[WITHDRAWALS_COLLECTION], { merge: true });
  await Promise.all(DEFAULT_SOCIAL_TASKS.map((task, index) => {
    const id = `default-${index + 1}`;
    return db.collection(TASKS_COLLECTION).doc(id).set({ ...task, systemSeed: true, createdAt: timestamp }, { merge: true });
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = String(stored || '').split(':');
  return Boolean(salt) && hashPassword(password, salt) === stored;
}

const EMAIL_PATTERN = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function assertValidEmail(value) {
  const email = normalizeEmail(value);
  if (!EMAIL_PATTERN.test(email)) {
    throw Object.assign(new Error('Geçerli bir e-posta adresi girin.'), { status: 400 });
  }
  return email;
}

function assertValidPassword(value) {
  const password = String(value || '').trim();
  if (password.length < 6) {
    throw Object.assign(new Error('Şifre en az 6 karakter olmalı.'), { status: 400 });
  }
  return password;
}

function displayNameFromEmail(email) {
  return email.split('@')[0] || email;
}

function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function createReferralCode(email) {
  const prefix = normalizeReferralCode(displayNameFromEmail(email)).slice(0, 8) || 'BIRD';
  return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function ensureReferralCode(user) {
  if (!user.referralCode) user.referralCode = createReferralCode(user.email || user.id || 'bird');
  return user;
}

function userIdFrom(req) {
  return String(req.header('x-user-id') || '').trim().toLowerCase();
}

function publicUser(user) {
  const { passwordHash, sessionTokenHash, ...safe } = user;
  safe.isAdmin = isAdminUser(user.id);
  return safe;
}

function now() {
  return Date.now();
}

function createDefaultUser(email, password, referredBy = '') {
  return {
    id: email,
    email,
    username: displayNameFromEmail(email),
    referralCode: createReferralCode(email),
    passwordHash: hashPassword(password),
    sessionTokenHash: '',
    silver: 1500,
    robux: 0,
    eggs: 0,
    uncollectedEggs: 100,
    birds: { baby: 1, owl: 0, swan: 0, phoenix: 0 },
    tasks: {},
    completedSocialTasks: {},
    txHistory: [{ title_TR: 'Sistem Hediyesi', title_EN: 'Welcome Bonus', time: '0m', change: '+1,500 S', type: 'plus' }],
    energyTimeRemaining: ENERGY_DURATION_MS,
    lastEnergyCheck: now(),
    dailyRobuxWithdrawn: 0,
    lastLimitResetTimestamp: now(),
    referredBy,
    createdAt: now(),
    updatedAt: now()
  };
}

function normalizeUser(user) {
  const normalized = {
    ...ensureReferralCode(user),
    silver: Number(user.silver || 0),
    robux: Number(user.robux || 0),
    eggs: Number(user.eggs || 0),
    uncollectedEggs: Number(user.uncollectedEggs || 0),
    birds: { baby: 0, owl: 0, swan: 0, phoenix: 0, ...(user.birds || {}) },
    tasks: user.tasks || {},
    completedSocialTasks: user.completedSocialTasks || {},
    txHistory: Array.isArray(user.txHistory) ? user.txHistory : [],
    energyTimeRemaining: Number(user.energyTimeRemaining ?? ENERGY_DURATION_MS),
    lastEnergyCheck: Number(user.lastEnergyCheck || now()),
    dailyRobuxWithdrawn: Number(user.dailyRobuxWithdrawn || 0),
    lastLimitResetTimestamp: Number(user.lastLimitResetTimestamp || now()),
    sessionTokenHash: user.sessionTokenHash || ''
  };
  return accrueWarehouseEggs(resetDailyLimitIfNeeded(normalized));
}

function resetDailyLimitIfNeeded(user) {
  if (now() - Number(user.lastLimitResetTimestamp || 0) >= 86400000) {
    user.dailyRobuxWithdrawn = 0;
    user.lastLimitResetTimestamp = now();
  }
  return user;
}

function getEggsPerMs(user) {
  const hourly = BIRD_DB.reduce((sum, bird) => sum + bird.prod * Number(user.birds?.[bird.id] || 0), 0);
  return hourly / 3600000;
}

function accrueWarehouseEggs(user) {
  const timestamp = now();
  const elapsed = Math.max(0, timestamp - Number(user.lastEnergyCheck || timestamp));
  if (elapsed > 0 && user.energyTimeRemaining > 0) {
    const activeMs = Math.min(elapsed, user.energyTimeRemaining);
    user.uncollectedEggs += getEggsPerMs(user) * activeMs;
    user.energyTimeRemaining = Math.max(0, user.energyTimeRemaining - elapsed);
  }
  user.lastEnergyCheck = timestamp;
  user.updatedAt = timestamp;
  return user;
}

async function getUser(id) {
  if (memoryMode) return memoryStore.users.get(id) || null;
  const snap = await db.collection(USERS_COLLECTION).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function setUser(id, data) {
  if (memoryMode) {
    memoryStore.users.set(id, data);
    return;
  }
  await db.collection(USERS_COLLECTION).doc(id).set(data, { merge: true });
}

async function findUserByReferralCode(referralCode) {
  const code = normalizeReferralCode(referralCode);
  if (!code) return null;
  if (memoryMode) {
    for (const user of memoryStore.users.values()) {
      if (!user.systemDoc && normalizeReferralCode(user.referralCode) === code) return normalizeUser(user);
    }
    return null;
  }
  const snap = await db.collection(USERS_COLLECTION).where('referralCode', '==', code).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return normalizeUser({ ...doc.data(), id: doc.id });
}

async function requireUser(req, res, next) {
  try {
    const id = userIdFrom(req);
    const token = sessionTokenFrom(req);
    if (!id || !token) return res.status(401).json({ error: 'Güvenli oturum bulunamadı. Lütfen tekrar giriş yapın.' });
    const user = await getUser(id);
    if (!user || !user.sessionTokenHash || user.sessionTokenHash !== hashSessionToken(token)) {
      return res.status(401).json({ error: 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.' });
    }
    req.userId = id;
    req.user = normalizeUser(user);
    await setUser(id, req.user);
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.userId)) return res.status(403).json({ error: 'Yönetici yetkisi gerekiyor.' });
  next();
}

async function listSocialTasks() {
  if (memoryMode) return Array.from(memoryStore.socialTasks.values());
  const snap = await db.collection(TASKS_COLLECTION).get();
  if (snap.empty) return DEFAULT_SOCIAL_TASKS.map((task, index) => ({ ...task, id: `default-${index + 1}` }));
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function addSocialTask(task) {
  if (memoryMode) {
    const id = crypto.randomUUID();
    memoryStore.socialTasks.set(id, { ...task, id });
    return id;
  }
  const ref = await db.collection(TASKS_COLLECTION).add(task);
  return ref.id;
}

async function getWithdrawals() {
  if (memoryMode) return Array.from(memoryStore.withdrawals.values()).filter(item => !item.systemDoc).sort((a, b) => b.createdAt - a.createdAt);
  const snap = await db.collection(WITHDRAWALS_COLLECTION).orderBy('createdAt', 'desc').limit(50).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function setWithdrawal(id, data) {
  if (memoryMode) {
    memoryStore.withdrawals.set(id, { ...data, id });
    return;
  }
  await db.collection(WITHDRAWALS_COLLECTION).doc(id).set(data, { merge: true });
}

function pushHistory(user, entry) {
  user.txHistory = [{ time: '0m', ...entry }, ...(user.txHistory || [])].slice(0, 40);
}

function assertAmount(value, min, label) {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount) || amount < min) throw Object.assign(new Error(`${label} minimum ${min} olmalı.`), { status: 400 });
  return amount;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: now() });
});

app.get('/api/config', (_req, res) => {
  res.json({ birds: BIRD_DB, dailyRobuxLimit: DAILY_ROBUX_LIMIT, energyDurationMs: ENERGY_DURATION_MS });
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const email = assertValidEmail(req.body.email || req.body.username);
    const password = assertValidPassword(req.body.password);
    const refCode = normalizeReferralCode(req.body.refCode);
    const id = email;
    if (await getUser(id)) return res.status(409).json({ error: 'Bu e-posta ile kayıtlı hesap zaten var.' });

    const user = createDefaultUser(email, password, refCode);
    if (refCode && refCode !== user.referralCode) {
      const referrer = await findUserByReferralCode(refCode);
      if (referrer && referrer.id !== id) {
        user.silver += 500;
        referrer.silver += 500;
        pushHistory(referrer, { title_TR: `Referans Bonusu (${email})`, title_EN: `Referral Bonus (${email})`, change: '+500 S', type: 'plus' });
        await setUser(referrer.id, referrer);
      }
    }
    await setUser(id, user);
    res.json({ user: publicUser(normalizeUser(user)) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = assertValidEmail(req.body.email || req.body.username);
    const password = String(req.body.password || '').trim();
    const user = await getUser(email);
    if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    const sessionToken = createSessionToken();
    const normalized = normalizeUser(user);
    normalized.sessionTokenHash = hashSessionToken(sessionToken);
    normalized.lastLoginAt = now();
    await setUser(email, normalized);
    res.json({ user: publicUser(normalized), sessionToken });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/forgot', async (req, res, next) => {
  try {
    const email = assertValidEmail(req.body.email || req.body.username);
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'Bu e-posta ile kayıtlı kullanıcı bulunamadı.' });
    res.json({ message: 'Şifre sıfırlama talebi alındı. Yönetici ile iletişime geçin.' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/me', requireUser, async (req, res) => {
  const tasks = await listSocialTasks();
  const withdrawals = await getWithdrawals();
  res.json({ user: publicUser(req.user), birds: BIRD_DB, socialTasks: tasks, withdrawals });
});

app.post('/api/warehouse/collect', requireUser, async (req, res, next) => {
  try {
    const collected = Math.floor(req.user.uncollectedEggs);
    if (collected < 1) return res.status(400).json({ error: 'Depoda toplanacak yumurta yok.' });
    req.user.eggs += collected;
    req.user.uncollectedEggs = 0;
    pushHistory(req.user, { title_TR: 'Yumurtalar Toplandı', title_EN: 'Eggs Collected', change: `+${collected.toLocaleString()} 🥚`, type: 'plus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), collected });
  } catch (err) {
    next(err);
  }
});

app.post('/api/convert/eggs-to-silver', requireUser, async (req, res, next) => {
  try {
    const amount = assertAmount(req.body.amount, 100, 'Yumurta');
    if (amount > req.user.eggs) return res.status(400).json({ error: 'Hesabınızda bu kadar yumurta yok.' });
    const silver = Math.floor(amount / 100);
    req.user.eggs -= amount;
    req.user.silver += silver;
    pushHistory(req.user, { title_TR: 'Yumurta Convert', title_EN: 'Egg Convert', change: `+${silver.toLocaleString()} S`, type: 'plus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), converted: amount, received: silver });
  } catch (err) {
    next(err);
  }
});

app.post('/api/convert/silver-to-robux', requireUser, async (req, res, next) => {
  try {
    const amount = assertAmount(req.body.amount, 100, 'Gümüş');
    if (amount > req.user.silver) return res.status(400).json({ error: 'Yetersiz gümüş bakiyesi.' });
    const robux = Math.floor(amount / 100);
    if (req.user.dailyRobuxWithdrawn + robux > DAILY_ROBUX_LIMIT) {
      return res.status(400).json({ error: `Günlük limit aşıldı. Kalan hakkınız: ${DAILY_ROBUX_LIMIT - req.user.dailyRobuxWithdrawn} R$.` });
    }
    req.user.silver -= amount;
    req.user.robux += robux;
    req.user.dailyRobuxWithdrawn += robux;
    pushHistory(req.user, { title_TR: 'Gümüş Convert', title_EN: 'Silver Convert', change: `+${robux.toLocaleString()} R$`, type: 'plus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), converted: amount, received: robux });
  } catch (err) {
    next(err);
  }
});

app.post('/api/birds/buy', requireUser, async (req, res, next) => {
  try {
    const bird = BIRD_DB.find(item => item.id === req.body.birdId);
    if (!bird) return res.status(404).json({ error: 'Kuş bulunamadı.' });
    if (req.user.silver < bird.cost) return res.status(400).json({ error: 'Gümüşünüz yetersiz.' });
    req.user.silver -= bird.cost;
    req.user.birds[bird.id] = Number(req.user.birds[bird.id] || 0) + 1;
    req.user.tasks[bird.id] = true;
    pushHistory(req.user, { title_TR: `${bird.name_TR} Alındı`, title_EN: `Purchased ${bird.name_EN}`, change: `-${bird.cost.toLocaleString()} S`, type: 'minus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), bird });
  } catch (err) {
    next(err);
  }
});

app.post('/api/energy/wake', requireUser, async (req, res, next) => {
  try {
    req.user.energyTimeRemaining = ENERGY_DURATION_MS;
    req.user.lastEnergyCheck = now();
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks/daily/complete', requireUser, async (req, res, next) => {
  try {
    const type = String(req.body.type || '').trim();
    const rewards = { baby: 500, owl: 1500, swan: 5000 };
    if (!rewards[type]) return res.status(404).json({ error: 'Görev bulunamadı.' });
    if (!req.user.birds[type]) return res.status(400).json({ error: 'Önce ilgili kuşu almalısınız.' });
    if (req.user.tasks[`reward-${type}`]) return res.status(400).json({ error: 'Bu ödül zaten alındı.' });
    req.user.tasks[`reward-${type}`] = true;
    req.user.silver += rewards[type];
    pushHistory(req.user, { title_TR: `Görev Ödülü`, title_EN: `Quest Reward`, change: `+${rewards[type]} S`, type: 'plus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/tasks/social/complete', requireUser, async (req, res, next) => {
  try {
    const taskId = String(req.body.taskId || '').trim();
    const task = (await listSocialTasks()).find(item => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Sosyal görev bulunamadı.' });
    if (req.user.completedSocialTasks[taskId]) return res.status(400).json({ error: 'Bu sosyal görev zaten tamamlandı.' });
    const reward = parseInt(task.reward, 10) || 0;
    req.user.completedSocialTasks[taskId] = true;
    req.user.silver += reward;
    pushHistory(req.user, { title_TR: `Sosyal: ${task.title_TR}`, title_EN: `Social: ${task.title_EN}`, change: `+${reward} S`, type: 'plus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), task });
  } catch (err) {
    next(err);
  }
});

app.post('/api/withdrawals', requireUser, async (req, res, next) => {
  try {
    const amount = assertAmount(req.body.amount, 100, 'Gümüş');
    const robloxUsername = String(req.body.robloxUsername || '').trim();
    if (!robloxUsername) return res.status(400).json({ error: 'Roblox kullanıcı adı zorunlu.' });
    if (amount > req.user.silver) return res.status(400).json({ error: 'Yetersiz gümüş bakiyesi.' });
    const robux = Math.floor(amount / 100);
    if (req.user.dailyRobuxWithdrawn + robux > DAILY_ROBUX_LIMIT) {
      return res.status(400).json({ error: `Günlük limit aşıldı. Kalan hakkınız: ${DAILY_ROBUX_LIMIT - req.user.dailyRobuxWithdrawn} R$.` });
    }
    req.user.silver -= amount;
    req.user.dailyRobuxWithdrawn += robux;
    const id = `TX-${crypto.randomInt(100000, 999999)}`;
    await setWithdrawal(id, { id, userId: req.userId, username: robloxUsername, amount, robux, status: 'pending', time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }), createdAt: now() });
    pushHistory(req.user, { title_TR: `Çekim Talebi (${robloxUsername})`, title_EN: `Withdrawal Request (${robloxUsername})`, change: `-${amount} S`, type: 'minus' });
    await setUser(req.userId, req.user);
    res.json({ user: publicUser(req.user), withdrawals: await getWithdrawals() });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/social-tasks', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const title_TR = String(req.body.title_TR || '').trim();
    const title_EN = String(req.body.title_EN || '').trim();
    const reward = `${assertAmount(req.body.reward, 1, 'Ödül')} S`;
    const link = String(req.body.link || '').trim();
    const platform = String(req.body.platform || 'default');
    const icons = { youtube: 'fa-youtube text-red-500', telegram: 'fa-telegram text-blue-400', twitter: 'fa-x-twitter text-slate-200', instagram: 'fa-instagram text-pink-400', default: 'fa-link text-amber-400' };
    if (!title_TR || !title_EN || !link) return res.status(400).json({ error: 'Görev başlığı ve link zorunlu.' });
    await addSocialTask({ title_TR, title_EN, reward, link, icon: icons[platform] || icons.default, createdAt: now() });
    res.json({ socialTasks: await listSocialTasks() });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Sunucu hatası.' });
});

bootstrapDataStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Robux Birds server running on http://localhost:${PORT}`);
      startKeepAlivePing();
    });
  })
  .catch(err => {
    console.error('Failed to bootstrap datastore:', err);
    process.exit(1);
  });
