// KOPASAMSU Telegram Worker v4 — Cloudflare Worker + required BOT_KV.
// Put this file in the Worker editor, add BOT_KV and WEBHOOK_SECRET, Deploy.
// The admin setup stores configuration durably; no Base44 function is called.
// GET /api/health, GET /api/status, POST /api/setup, POST /api/catalog,
// POST /api/test and POST /tg (Telegram secret-token header).
// Never publish a bot token or bot key in this source file.

const DIVIDER = '━━━━━━━━━━━━━━━';
const MEMBER_STATUS = ['member', 'administrator', 'creator'];
const SUCCESS_STATES = ['success', 'successful', 'completed', 'complete', 'paid', 'valid', 'ok', 'true', '1', 'confirmed'];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-bot-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

// Configuration must survive cold starts. Never pretend RAM is durable storage.
async function storeGet(env, key) {
  return env.BOT_KV ? env.BOT_KV.get(key) : null;
}

async function storePut(env, key, value) {
  if (!env.BOT_KV) throw new Error('KV_MISSING: BOT_KV binding যুক্ত করে Deploy করুন।');
  await env.BOT_KV.put(key, value);
}

async function readJson(env, key) {
  const raw = await storeGet(env, key);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// প্যানেল থেকে সেভ করা সেটিংস (টোকেন সহ) — host-এর env না থাকলেও বট চলে।
async function resolveEnv(rawEnv) {
  const saved = await readJson(rawEnv, 'settings');
  return {
    ...rawEnv,
    TELEGRAM_BOT_TOKEN: saved.bot_token || rawEnv.TELEGRAM_BOT_TOKEN || '',
    BOT_SETTINGS: saved,
    ADMIN_CHAT_ID: saved.admin_chat_id || rawEnv.ADMIN_CHAT_ID || '',
    SITE_URL: saved.site_url || rawEnv.SITE_URL || '',
    BRAND_NAME: saved.brand_name || rawEnv.BRAND_NAME || '',
    CHANNEL_USERNAME: saved.channel_username || rawEnv.CHANNEL_USERNAME || '',
    VERIFY_API_URL: saved.verify_api_url || rawEnv.VERIFY_API_URL || '',
    VERIFY_API_KEY: saved.verify_api_key || rawEnv.VERIFY_API_KEY || '',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify({ service: 'kopasamsu-bot', version: 4, ...data }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value) {
  const n = Number(value) || 0;
  return `৳${n.toLocaleString('en-US')}`;
}

async function tg(env, method, payload = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'no token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (error) {
    console.error('telegram call failed', method, error?.message);
    return { ok: false, description: error?.message };
  }
}

const squareStrip = () => '🟥🟧🟨🟩🟦🟪';

function boxTitle(icon, brand, title) {
  return `${squareStrip()}\n${icon} <b>${esc(title)}</b>\n<i>${esc(brand)}</i>\n${DIVIDER}`;
}

function card(icon, title, lines = []) {
  const body = lines.filter((line) => line !== null && line !== undefined && String(line).trim() !== '');
  return [`┏ ${icon} <b>${esc(title)}</b>`, ...body.map((line) => `┃ ${line}`), '┗━━━━━━━━━━━━'].join('\n');
}

function progressBar(percent, label = '') {
  const total = 10;
  const filled = Math.max(0, Math.min(total, Math.round((Number(percent) || 0) / 10)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(total - filled)} ${esc(label)}`.trim();
}

function rows(...buttons) {
  return buttons
    .flat()
    .filter((button) => button && button.url && /^https?:\/\//i.test(String(button.url)))
    .map((button) => [{ text: String(button.text || '🔗').slice(0, 60), url: String(button.url) }]);
}

function channelLink(catalog) {
  if (/^https:\/\/t\.me\//i.test(String(catalog.channel_url || ''))) return catalog.channel_url;
  const name = String(catalog.channel || '').replace(/^@/, '').trim();
  if (!name) return '';
  if (/^-?\d+$/.test(name)) return '';
  return `https://t.me/${name}`;
}

// ---- ক্যাটালগ -------------------------------------------------------------
async function loadCatalog(env) {
  const stored = await storeGet(env, 'catalog');
  let data = {};
  if (stored) {
    try {
      data = JSON.parse(stored);
    } catch {
      data = {};
    }
  }
  return {
    brand: data.brand || env.BRAND_NAME || 'KOPASAMSU',
    site: String(data.site || env.SITE_URL || '').replace(/\/$/, ''),
    channel: env.CHANNEL_USERNAME || data.channel || '',
    channel_url: env.BOT_SETTINGS?.channel_url || '',
    welcome_text: env.BOT_SETTINGS?.welcome_text || '',
    welcome_enabled: env.BOT_SETTINGS?.welcome_enabled !== false,
    welcome_photo: env.BOT_SETTINGS?.welcome_photo !== false,
    welcome_buttons: env.BOT_SETTINGS?.welcome_buttons || [],
    panel_intro: env.BOT_SETTINGS?.panel_intro || '',
    payment_text: env.BOT_SETTINGS?.payment_text || '',
    support: data.support && typeof data.support === 'object' ? data.support : {},
    panels: Array.isArray(data.panels) ? data.panels : [],
    topups: Array.isArray(data.topups) ? data.topups : [],
    market: Array.isArray(data.market) ? data.market : [],
    payments: Array.isArray(data.payments) ? data.payments : [],
    offers: Array.isArray(data.offers) ? data.offers : [],
  };
}

// ---- অর্ডার ---------------------------------------------------------------
function adminChats(env) {
  return String(env.ADMIN_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

async function notifyAdmins(env, text) {
  for (const chatId of adminChats(env)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

async function saveRecent(env, entry) {
  const list = await recentOrders(env);
  list.unshift(entry);
  await storePut(env, 'recent_orders', JSON.stringify(list.slice(0, 5)));
}

async function recentOrders(env) {
  const raw = await storeGet(env, 'recent_orders');
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function pick(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), source);
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

// ক্রেতার নিজের ট্রানজেকশন-চেক API দিয়ে যাচাই — এতে কোনো Base44 ক্রেডিট লাগে না।
async function verifyTransaction(env, { trxid, method, amount }) {
  if (!env.VERIFY_API_URL || !env.VERIFY_API_KEY) {
    return { ok: false, configured: false, message: 'অটো ভেরিফাই API সেট করা নেই — অ্যাডমিন ম্যানুয়ালি যাচাই করবেন' };
  }
  const url = String(env.VERIFY_API_URL)
    .replace('{apikey}', encodeURIComponent(env.VERIFY_API_KEY))
    .replace('{trxid}', encodeURIComponent(trxid || ''))
    .replace('{method}', encodeURIComponent(method || ''))
    .replace('{amount}', encodeURIComponent(amount ?? ''));

  let payload = {};
  try {
    const res = await fetch(url, { method: String(env.VERIFY_HTTP_METHOD || 'GET').toUpperCase() });
    payload = await res.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, message: `ভেরিফাই API-তে পৌঁছানো যায়নি (${error?.message || 'network'})` };
  }

  const scope = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const state = String(
    pick(scope, ['status', 'transactionStatus', 'paymentStatus', 'trx_status', 'state', 'result']) ??
      pick(payload, ['status', 'success']) ??
      ''
  ).toLowerCase();
  const paid = Number(pick(scope, ['amount', 'trxAmount', 'total', 'value', 'paid_amount']) ?? pick(payload, ['amount']) ?? 0) || 0;
  const success = SUCCESS_STATES.includes(state) || payload?.success === true || scope?.success === true;

  if (!success) return { ok: false, message: `লেনদেন পাওয়া যায়নি (স্ট্যাটাস: ${state || 'unknown'})` };

  const strict = String(env.STRICT_AMOUNT || 'true') !== 'false';
  if (strict && Number(amount) > 0 && paid > 0 && paid + 0.5 < Number(amount)) {
    return { ok: false, message: `টাকার পরিমাণ মেলেনি — পাঠানো ${money(paid)}, দরকার ${money(amount)}` };
  }

  return { ok: true, amount: paid, message: '✅ লেনদেন যাচাই হয়েছে' };
}

async function handleOrder(env, order = {}) {
  const code = String(order.order_code || '').trim();
  const trxid = String(order.transaction_id || '').trim();
  const price = Number(order.price) || 0;
  if (!code || !trxid) return { ok: false, error: 'অর্ডার কোড ও TrxID দুটোই দরকার' };

  const alreadyUsed = await storeGet(env, `trx:${trxid}`);
  if (alreadyUsed) return { ok: false, verified: false, error: `এই TrxID আগে ব্যবহার হয়েছে (${alreadyUsed})` };

  const check = await verifyTransaction(env, { trxid, method: order.method, amount: price });

  const notice = [
    boxTitle(check.ok ? '✅' : '⚠️', env.BRAND_NAME || 'KOPASAMSU', check.ok ? 'পেমেন্ট রিসিভড' : 'পেমেন্ট যাচাই দরকার'),
    card('🧾', 'অর্ডার', [
      `🆔 কোড: <code>${esc(code)}</code>`,
      `📦 আইটেম: ${esc(order.item_name || '—')}`,
      `💰 দাম: <b>${money(price)}</b>`,
      `💳 মাধ্যম: ${esc(order.method || '—')}`,
      `📱 সেন্ডার: ${esc(order.sender_number || '—')}`,
      `🔑 TrxID: <code>${esc(trxid)}</code>`,
      `👤 ইউজার: ${esc(order.user_name || '—')}`,
    ]),
    progressBar(check.ok ? 100 : 50, check.ok ? 'ভেরিফায়েড' : 'ম্যানুয়াল চেক'),
    check.message ? `<i>${esc(check.message)}</i>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  await notifyAdmins(env, notice);
  await saveRecent(env, {
    code,
    trxid,
    item_name: order.item_name || '',
    price,
    method: order.method || '',
    user_name: order.user_name || '',
    verified: Boolean(check.ok),
    at: new Date().toISOString(),
  });

  if (!check.ok) return { ok: false, verified: false, error: check.message || 'যাচাই করা যায়নি', notice_sent: true };

  await storePut(env, `trx:${trxid}`, `${code} · ${new Date().toISOString().slice(0, 10)}`);

  const delivery = order.delivery || {};
  const lines = [
    boxTitle('🎉', env.BRAND_NAME || 'KOPASAMSU', 'ডেলিভারি সম্পন্ন'),
    card('📦', 'আপনার অর্ডার', [
      `🆔 কোড: <code>${esc(code)}</code>`,
      `📦 আইটেম: ${esc(order.item_name || '—')}`,
      delivery.email ? `📧 ইমেইল: <code>${esc(delivery.email)}</code>` : '',
      delivery.password ? `🔒 পাসওয়ার্ড: <code>${esc(delivery.password)}</code>` : '',
      delivery.link ? `🔗 লিংক: ${esc(delivery.link)}` : '',
      delivery.note ? `📝 ${esc(delivery.note)}` : '',
    ]),
    progressBar(100, 'সব ঠিক আছে'),
  ]
    .filter(Boolean)
    .join('\n\n');

  if (order.chat_id) {
    await tg(env, 'sendMessage', { chat_id: order.chat_id, text: lines, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  return { ok: true, verified: true, message: 'ভেরিফায়েড ও ডেলিভারি পাঠানো হয়েছে', delivery_text: lines };
}

// ---- কার্ড -----------------------------------------------------------------
function fullName(member) {
  return [member?.first_name, member?.last_name].filter(Boolean).join(' ') || member?.username || 'বন্ধু';
}

function siteButtons(catalog) {
  return rows(
    catalog.site ? { text: '🌐 ওয়েবসাইট', url: catalog.site } : null,
    channelLink(catalog) ? { text: '📢 চ্যানেল', url: channelLink(catalog) } : null
  );
}

function welcomeCard(catalog, member) {
  return {
    text: [
      boxTitle('🎉', catalog.brand, `স্বাগতম, ${fullName(member)}`),
      catalog.welcome_text ? esc(catalog.welcome_text.replace(/\{name\}/g, fullName(member))) : '',
      card('🛍️', 'আমাদের শপ', [
        '📦 /panels — প্যানেল ও দাম',
        '💎 /topup — ডায়মন্ড টপ-আপ',
        '🎮 /market — ফ্রি ফায়ার আইডি',
        '💳 /payments — পেমেন্ট নাম্বার',
        '🎁 /offer — লাইভ অফার',
        '🧭 /menu — সব মেনু একসাথে',
      ]),
      progressBar(100, 'ইনস্ট্যান্ট ডেলিভারি'),
    ].join('\n\n'),
    buttons: [...siteButtons(catalog), ...rows(...catalog.welcome_buttons.map(b => ({ text: b.label, url: b.url })))],
    photo_user_id: catalog.welcome_photo ? member?.id : null,
  };
}

function joinGate(catalog) {
  const link = channelLink(catalog);
  return {
    text: [
      boxTitle('🔐', catalog.brand, 'চ্যানেল ভেরিফিকেশন দরকার'),
      card('📢', 'কী করতে হবে', ['আমাদের চ্যানেলে জয়েন করুন', 'তারপর ✅ ভেরিফাই চাপুন', 'ভেরিফাই হলে বট আনলক হবে']),
      '🔒 চ্যানেল জয়েন ছাড়া বট ও অর্ডার আনলক হবে না।',
    ].join('\n\n'),
    buttons: [
      ...(link ? [[{ text: '📢 চ্যানেলে জয়েন করুন', url: link }]] : []),
      [{ text: '✅ ভেরিফাইড করুন', callback_data: 'verify_join' }],
    ],
  };
}

function menuCard(env, catalog) {
  return {
    text: [
      boxTitle('🧭', catalog.brand, 'বট মেনু'),
      card('🛍️', 'শপ', ['📦 /panels — প্যানেল ও দাম', '💎 /topup — ডায়মন্ড টপ-আপ', '🎮 /market — ফ্রি ফায়ার আইডি', '🎁 /offer — লাইভ অফার']),
      card('💳', 'পেমেন্ট', ['💳 /payments — পেমেন্ট নাম্বার', '🧾 /proof — লাইভ পেমেন্ট প্রুফ']),
      card('👤', 'অ্যাকাউন্ট', ['👤 /profile — প্রোফাইল', '🎧 /support — সাপোর্ট']),
      progressBar(100, catalog.channel ? 'ভেরিফায়েড' : 'বট প্রস্তুত'),
    ].join('\n\n'),
    buttons: siteButtons(catalog),
  };
}

function panelsCard(env, catalog) {
  const items = catalog.panels || [];
  const lines = [boxTitle('📦', catalog.brand, 'সব প্যানেল ও দাম'), esc(catalog.panel_intro || '')];
  items.slice(0, 6).forEach((panel, index) => {
    lines.push(
      card('📦', `${index + 1}. ${esc(panel.name)}`, [
        `💰 দাম: <b>${money(panel.price)}</b>${panel.badge ? ` · ${esc(panel.badge)}` : ''}`,
        panel.subtitle ? `<i>${esc(String(panel.subtitle).slice(0, 70))}</i>` : '',
      ])
    );
  });
  if (items.length === 0) lines.push(card('📭', 'খালি', ['অ্যাডমিন প্যানেল থেকে ক্যাটালগ পাঠালে তালিকা দেখা যাবে']));
  lines.push(progressBar(100, 'ইনস্ট্যান্ট ডেলিভারি'));
  return {
    text: lines.join('\n\n'),
    buttons: rows(catalog.site ? { text: '🛒 প্যানেল কিনুন', url: `${catalog.site}/panels` } : null),
  };
}

function topupCard(env, catalog) {
  const items = catalog.topups || [];
  const lines = [boxTitle('💎', catalog.brand, 'ডায়মন্ড টপ-আপ')];
  items.slice(0, 6).forEach((pkg) => {
    lines.push(
      card('💎', esc(String(pkg.name).slice(0, 32)), [
        `💰 দাম: <b>${money(pkg.price)}</b>`,
        pkg.details ? `<i>${esc(String(pkg.details).slice(0, 60))}</i>` : '',
      ])
    );
  });
  if (items.length === 0) lines.push(card('📭', 'খালি', ['অ্যাডমিন থেকে ক্যাটালগ পাঠালে প্যাকেজ দেখা যাবে']));
  lines.push(progressBar(100, 'ইনস্ট্যান্ট টপ-আপ'));
  return {
    text: lines.join('\n\n'),
    buttons: rows(catalog.site ? { text: '💎 টপ-আপ করুন', url: `${catalog.site}/topup` } : null),
  };
}

function marketCard(env, catalog) {
  const items = catalog.market || [];
  const lines = [boxTitle('🎮', catalog.brand, 'ফ্রি ফায়ার আইডি')];
  items.slice(0, 5).forEach((item) => {
    lines.push(
      card('🎮', esc(String(item.title).slice(0, 34)), [
        `💰 দাম: <b>${money(item.price)}</b>`,
        [item.level ? `Lv ${item.level}` : '', item.server ? esc(item.server) : '', item.br_rank ? `BR ${esc(item.br_rank)}` : '']
          .filter(Boolean)
          .join(' · '),
      ])
    );
  });
  if (items.length === 0) lines.push(card('📭', 'খালি', ['এখনো কোনো আইডি পাঠানো হয়নি']));
  lines.push(progressBar(100, 'হাতে যাচাই করা আইডি'));
  return {
    text: lines.join('\n\n'),
    buttons: rows(catalog.site ? { text: '🎮 মার্কেটপ্লেস', url: `${catalog.site}/marketplace` } : null),
  };
}

function paymentsCard(env, catalog) {
  const items = catalog.payments || [];
  const lines = [boxTitle('💳', catalog.brand, 'পেমেন্ট নাম্বার'), esc(catalog.payment_text || '')];
  items.slice(0, 8).forEach((method) => {
    lines.push(
      card('🏦', esc(String(method.name).slice(0, 30)), [
        method.number ? `নাম্বার: <code>${esc(method.number)}</code>` : '',
        `ধরন: ${esc(method.type || 'personal')}`,
        '✅ Send Money',
      ])
    );
  });
  if (items.length === 0) lines.push(card('📭', 'খালি', ['পেমেন্ট নাম্বার এখনো পাঠানো হয়নি']));
  lines.push(card('📝', 'নিয়ম', ['পেমেন্ট করে TrxID সাইটে দিন', 'যাচাই হলে সাথে সাথে ডেলিভারি']));
  return {
    text: lines.join('\n\n'),
    buttons: rows(catalog.site ? { text: '💰 ওয়ালেটে অ্যাড মানি', url: `${catalog.site}/wallet` } : null),
  };
}

function offersCard(env, catalog) {
  const items = catalog.offers || [];
  const lines = [boxTitle('🎁', catalog.brand, 'লাইভ অফার')];
  items.slice(0, 4).forEach((offer) => {
    lines.push(
      card('🔥', esc(String(offer.title || 'স্পেশাল অফার').slice(0, 32)), [
        offer.text ? esc(String(offer.text).slice(0, 150)) : '',
        offer.button_text ? `👉 ${esc(String(offer.button_text).slice(0, 40))}` : '',
      ])
    );
  });
  if (items.length === 0) lines.push(card('📭', 'খালি', ['এখন কোনো অফার চালু নেই']));
  lines.push(progressBar(100, 'সীমিত সময়ের অফার'));
  return {
    text: lines.join('\n\n'),
    buttons: rows(
      ...items.slice(0, 2).map((offer) => ({ text: offer.button_text || '🎁 অফার দেখুন', url: offer.button_url })),
      catalog.site ? { text: '🛒 সব প্যানেল', url: `${catalog.site}/panels` } : null
    ),
  };
}

async function proofCard(env, catalog) {
  const items = await recentOrders(env);
  const mask = (value) => {
    const text = String(value || '');
    return text.length <= 4 ? '••••' : `${text.slice(0, 3)}•••${text.slice(-3)}`;
  };
  const lines = [boxTitle('🧾', catalog.brand, 'লাইভ পেমেন্ট প্রুফ')];
  if (items.length === 0) lines.push(card('📭', 'খালি', ['এখনো কোনো পেমেন্ট আসেনি']));
  items.forEach((order) => {
    lines.push(
      card(order.verified ? '✅' : '⏳', esc(String(order.item_name || order.code || 'অর্ডার').slice(0, 32)), [
        `💰 ${money(order.price)}`,
        `💳 ${esc(order.method || 'Wallet')}`,
        `🧾 TrxID: <code>${esc(mask(order.trxid))}</code>`,
        `👤 ${esc(mask(order.user_name))} · ${order.verified ? '✅ ভেরিফায়েড' : '⏳ যাচাই চলছে'}`,
      ])
    );
  });
  lines.push('🔒 ক্রেতাদের নাম্বার ও TrxID গোপন রাখা হয়।');
  return {
    text: lines.join('\n\n'),
    buttons: rows(catalog.site ? { text: '🛒 আমিও কিনতে চাই', url: `${catalog.site}/panels` } : null),
  };
}

function supportCard(env, catalog) {
  const support = catalog.support || {};
  return {
    text: [
      boxTitle('🎧', catalog.brand, 'সাপোর্ট ও যোগাযোগ'),
      card('💬', 'যোগাযোগ', [
        support.telegram ? `টেলিগ্রাম: ${esc(support.telegram)}` : '',
        support.whatsapp ? `হোয়াটসঅ্যাপ: ${esc(support.whatsapp)}` : '',
        'সময়: সকাল ১০টা — রাত ১১টা',
      ]),
      card('📋', 'কমান্ড', ['📦 /panels · 🎮 /market', '💎 /topup · 💳 /payments', '🎁 /offer · 🧭 /menu']),
      progressBar(100, `${catalog.brand} সাপোর্ট`),
    ]
      .filter(Boolean)
      .join('\n\n'),
    buttons: rows(
      support.telegram && /^https?:\/\//i.test(support.telegram) ? { text: '💬 টেলিগ্রাম সাপোর্ট', url: support.telegram } : null,
      channelLink(catalog) ? { text: '📢 চ্যানেল', url: channelLink(catalog) } : null
    ),
  };
}

function profileCard(catalog, member) {
  return {
    text: [
      boxTitle('👤', catalog.brand, 'আপনার প্রোফাইল'),
      card('🙋', fullName(member), [
        member?.username ? `ইউজারনেম: @${esc(member.username)}` : 'ইউজারনেম: নেই',
        `চ্যাট আইডি: <code>${esc(member?.id || '')}</code>`,
        `যোগদান: ${esc(catalog.channel || '—')}`,
      ]),
      card('🛡️', 'স্ট্যাটাস', ['টেলিগ্রাম: ✅ ভেরিফায়েড', `চ্যানেল: ${catalog.channel ? '✅ সেট করা আছে' : '— সেট করা হয়নি'}`, 'সাপোর্ট: 🕓 ২৪/৭']),
      DIVIDER,
    ].join('\n\n'),
    buttons: siteButtons(catalog),
  };
}

// ---- হ্যান্ডলার -------------------------------------------------------------
async function isJoined(env, userId) {
  if (!env.CHANNEL_USERNAME || !userId) return true;
  const res = await tg(env, 'getChatMember', { chat_id: env.CHANNEL_USERNAME, user_id: userId });
  if (!res?.ok) return false;
  return MEMBER_STATUS.includes(res?.result?.status) || (res.result?.status === 'restricted' && res.result?.is_member === true);
}

async function send(env, chatId, view) {
  if (view.photo_user_id) {
    const photos = await tg(env, 'getUserProfilePhotos', { user_id: view.photo_user_id, limit: 1 });
    const photo = photos.result?.photos?.[0]?.slice(-1)?.[0]?.file_id;
    if (photo && String(view.text || '').length <= 1024) {
      const sent = await tg(env, 'sendPhoto', { chat_id: chatId, photo, caption: view.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: view.buttons || [] } });
      if (sent.ok) return sent;
    }
  }
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text: String(view.text || '').slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: view.buttons || [] },
  });
}

const COMMANDS = {
  '/menu': menuCard,
  '/about': menuCard,
  '/panels': panelsCard,
  '/topup': topupCard,
  '/diamond': topupCard,
  '/market': marketCard,
  '/payments': paymentsCard,
  '/offer': offersCard,
  '/offers': offersCard,
  '/proof': proofCard,
  '/support': supportCard,
};

async function handleCallback(env, callback, catalog) {
  const chatId = callback.message?.chat?.id || callback.from?.id;
  const data = String(callback.data || '');

  if (data === 'verify_join') {
    const joined = await isJoined(env, callback.from?.id);
    if (!joined) {
      return tg(env, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: '❌ আগে চ্যানেলে জয়েন করুন, তারপর আবার ভেরিফাই চাপুন।',
        show_alert: true,
      });
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: '✅ ভেরিফায়েড! বট আনলক হয়েছে।' });
    return send(env, chatId, welcomeCard(catalog, callback.from));
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: callback.id });
  if (data === 'profile') return send(env, chatId, profileCard(catalog, callback.from));
  return send(env, chatId, menuCard(env, catalog));
}

async function handleUpdate(env, update) {
  const catalog = await loadCatalog(env);

  const callback = update.callback_query;
  if (callback?.id) return handleCallback(env, callback, catalog);

  const membership = update.my_chat_member;
  if (membership && ['administrator', 'member'].includes(membership.new_chat_member?.status)) {
    return send(env, membership.chat.id, menuCard(env, catalog));
  }
  const change = update.chat_member;
  if (change && catalog.welcome_enabled && ['left', 'kicked'].includes(change.old_chat_member?.status) && MEMBER_STATUS.includes(change.new_chat_member?.status)) {
    return send(env, change.chat.id, welcomeCard(catalog, change.new_chat_member.user));
  }
  const members = update.message?.new_chat_members;
  if (members?.length && catalog.welcome_enabled) {
    for (const member of members.slice(0, 3)) {
      if (member.is_bot) continue;
      await send(env, update.message.chat.id, welcomeCard(catalog, member));
    }
    return;
  }

  const message = update.message || update.channel_post;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const from = message.from || {};
  const command = String(message.text).trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const isPrivate = String(chatId) === String(from.id);
  if (command === '/id' || command === '/chatid') {
    return send(env, chatId, { text: `এই চ্যাটের id: <code>${esc(chatId)}</code>\nঅ্যাডমিন প্যানেলের admin chat id ঘরে এটি দিন।`, buttons: [] });
  }
  const joined = isPrivate ? await isJoined(env, from.id) : true;

  if (command === '/start' || command === '/help') {
    return send(env, chatId, joined ? welcomeCard(catalog, from) : joinGate(catalog));
  }

  if (isPrivate && !joined) return send(env, chatId, joinGate(catalog));

  if (command === '/profile' || command === '/me' || command === '/id') {
    return send(env, chatId, profileCard(catalog, from));
  }

  const builder = COMMANDS[command];
  return send(env, chatId, await (builder || menuCard)(env, catalog));
}

// Only the authenticated admin can change this bot's single webhook.
async function connectionStatus(env, origin, identity = null) {
  const me = identity || await tg(env, 'getMe');
  if (!me.ok) return { ok: true, kv: Boolean(env.BOT_KV), token: false, connected: false, error: 'Telegram token গ্রহণ করেনি। BotFather থেকে token মিলিয়ে নিন।' };
  const hook = await tg(env, 'getWebhookInfo');
  if (!hook.ok) throw new Error('Telegram-এর সংযোগের অবস্থা পাওয়া যায়নি। আবার চেষ্টা করুন।');
  let channelOk = true;
  let channelError = '';
  if (env.CHANNEL_USERNAME) {
    const member = await tg(env, 'getChatMember', { chat_id: env.CHANNEL_USERNAME, user_id: me.result.id });
    channelOk = member.ok && ['administrator', 'creator'].includes(member.result?.status);
    if (!channelOk) channelError = member.description || 'এই চ্যানেলে বটকে admin করুন।';
  }
  const info = hook.result || {};
  return {
    ok: true, kv: Boolean(env.BOT_KV), token: true, active: env.BOT_SETTINGS?.active !== false,
    connected: info.url === `${origin}/tg`, username: me.result.username,
    pending: info.pending_update_count || 0, last_error: info.last_error_message || '', last_error_at: info.last_error_date || null,
    channel_configured: Boolean(env.CHANNEL_USERNAME), channel_ok: Boolean(channelOk), channel_error: channelError,
  };
}

async function connectWebhook(env, origin, identity) {
  const hook = await tg(env, 'setWebhook', {
    url: `${origin}/tg`, secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query', 'channel_post', 'my_chat_member', 'chat_member'],
  });
  if (!hook.ok) return json({ ok: false, error: hook.description || 'Telegram সংযোগ গ্রহণ করেনি।' }, 502);
  const commands = await tg(env, 'setMyCommands', { commands: [
    ['start', 'বট শুরু করুন'], ['menu', 'সব মেনু'], ['panels', 'প্যানেল ও দাম'], ['topup', 'টপ আপ'],
    ['market', 'আইডি মার্কেট'], ['payments', 'পেমেন্ট নাম্বার'], ['offer', 'অফার'], ['support', 'সাপোর্ট'],
    ['profile', 'প্রোফাইল'], ['id', 'আমার chat id'], ['chatid', 'এই চ্যাটের id'],
  ].map(([command, description]) => ({ command, description })) });
  const status = await connectionStatus(env, origin, identity);
  if (!status.connected) return json({ ok: false, error: 'Telegram webhook এই Worker-এ বসেনি। আবার সংযোগ দিন।' }, 502);
  return json({ ...status, commands_error: commands.ok ? '' : commands.description });
}

async function readBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 131072) throw new Error('অনুরোধের তথ্য অনেক বড়।');
  try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* show a bounded form error */ }
  throw new Error('সঠিক JSON তথ্য পাঠান।');
}

async function handleRequest(request, rawEnv) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const env = await resolveEnv(rawEnv || {});
  if (['/', '/api/health'].includes(url.pathname) && request.method === 'GET') {
    return json({ ok: true, kv: Boolean(env.BOT_KV), token: Boolean(env.TELEGRAM_BOT_TOKEN), storage: env.BOT_KV ? 'persistent-kv' : 'missing' });
  }
  if (url.pathname === '/tg') {
    if (request.method !== 'POST') return json({ ok: false, error: 'POST প্রয়োজন।' }, 405);
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'Forbidden' }, 403);
    if (!env.BOT_KV || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'সেটিংস এখনো পাওয়া যায়নি।' }, 503);
    if (env.BOT_SETTINGS?.active === false) return json({ ok: true, skipped: 'bot_disabled' });
    const result = await handleUpdate(env, await readBody(request));
    if (result?.ok === false) return json({ ok: false, error: 'Telegram reply failed' }, 503);
    return json({ ok: true });
  }
  const paths = ['/api/setup', '/api/connect', '/api/catalog', '/api/status', '/api/test', '/api/order'];
  if (!paths.includes(url.pathname)) return json({ ok: false, error: 'এই পথ নেই। Worker-এর মূল URL দিন।' }, 404);
  if (!env.WEBHOOK_SECRET || request.headers.get('x-bot-key') !== env.WEBHOOK_SECRET) return json({ ok: false, error: '403: bot key ও Worker-এর WEBHOOK_SECRET মিলছে না।' }, 403);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(env.WEBHOOK_SECRET)) return json({ ok: false, error: 'নতুন ২৪–১২৮ অক্ষরের key তৈরি করে WEBHOOK_SECRET-এ বসান।' }, 400);
  if (!env.BOT_KV) return json({ ok: false, error: 'KV_MISSING: BOT_KV binding যুক্ত করে Deploy করুন।' }, 409);
  const expectedMethod = url.pathname === '/api/status' ? 'GET' : 'POST';
  if (request.method !== expectedMethod) return json({ ok: false, error: `${expectedMethod} প্রয়োজন।` }, 405);
  if (url.pathname === '/api/status') return json(await connectionStatus(env, url.origin));
  const body = await readBody(request);
  if (['/api/setup', '/api/connect'].includes(url.pathname)) {
    const token = String(body.bot_token || env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return json({ ok: false, error: 'BotFather-এর পুরো token দিন।' }, 400);
    const identity = await tg({ ...env, TELEGRAM_BOT_TOKEN: token }, 'getMe');
    if (!identity.ok) return json({ ok: false, error: '401: Telegram token গ্রহণ করেনি। BotFather থেকে সঠিক token নিন।' }, 401);
    const channel = String(body.channel_username || '').trim();
    if (channel && !/^(@[A-Za-z][A-Za-z0-9_]{3,}|-?\d+)$/.test(channel)) return json({ ok: false, error: 'চ্যানেলের @username বা numeric id দিন।' }, 400);
    const chats = String(body.admin_chat_id || '').split(',').map(v => v.trim()).filter(Boolean);
    if (chats.length > 5 || chats.some(v => !/^(-?\d+|@[A-Za-z][A-Za-z0-9_]{3,})$/.test(v))) return json({ ok: false, error: 'সর্বোচ্চ ৫টি সঠিক admin chat id কমা দিয়ে দিন।' }, 400);
    if (body.site_url && !/^https:\/\//i.test(String(body.site_url))) return json({ ok: false, error: 'সাইটের https লিংক দিন।' }, 400);
    const settings = {
      bot_token: token, admin_chat_id: chats.join(','), site_url: String(body.site_url || '').slice(0, 500),
      brand_name: String(body.brand_name || 'KOPASAMSU').slice(0, 60), channel_username: channel,
      channel_url: /^https:\/\/t\.me\//i.test(String(body.channel_url || '')) ? String(body.channel_url).slice(0, 500) : '',
      active: body.active !== false, welcome_enabled: body.welcome_enabled !== false, welcome_photo: body.welcome_photo !== false,
      welcome_text: String(body.welcome_text || '').slice(0, 300),
      welcome_buttons: (Array.isArray(body.welcome_buttons) ? body.welcome_buttons : []).filter(b => b && /^https?:\/\//i.test(String(b.url))).slice(0, 2).map(b => ({ label: String(b.label || 'লিংক').slice(0, 40), url: String(b.url).slice(0, 500) })),
      panel_intro: String(body.panel_intro || '').slice(0, 150), payment_text: String(body.payment_text || '').slice(0, 300),
      updated_at: new Date().toISOString(),
    };
    await storePut(env, 'settings', JSON.stringify(settings));
    const updated = { ...env, TELEGRAM_BOT_TOKEN: token, ADMIN_CHAT_ID: settings.admin_chat_id, CHANNEL_USERNAME: channel, SITE_URL: settings.site_url, BRAND_NAME: settings.brand_name, BOT_SETTINGS: settings };
    return connectWebhook(updated, url.origin, identity);
  }
  if (url.pathname === '/api/catalog') {
    for (const name of ['panels', 'topups', 'market', 'payments', 'offers']) {
      if (body[name] !== undefined && !Array.isArray(body[name])) return json({ ok: false, error: 'ক্যাটালগের তালিকা সঠিক নয়।' }, 400);
      body[name] = (body[name] || []).slice(0, name === 'offers' ? 6 : 50);
    }
    await storePut(env, 'catalog', JSON.stringify(body));
    return json({ ok: true, saved: true, storage: 'persistent-kv' });
  }
  if (url.pathname === '/api/test') {
    const chats = adminChats(env).slice(0, 5);
    if (!chats.length) return json({ ok: false, error: 'আগে বটে Start → /id দিন। ওই id প্যানেলে বসিয়ে সেভ করুন; তারপর টেস্ট পাঠান।' }, 400);
    const results = await Promise.all(chats.map(chat_id => tg(env, 'sendMessage', { chat_id, text: 'বটের সংযোগ ঠিক আছে। এই টেস্ট বার্তা Cloudflare Worker থেকে এসেছে।' })));
    return json({ ok: true, total: chats.length, sent: results.filter(r => r.ok).length, failures: results.flatMap((r, i) => r.ok ? [] : [`${chats[i]}: ${r.description || 'পাঠানো যায়নি'}`]) });
  }
  const result = await handleOrder(env, body);
  return json(result, result.ok ? 200 : 422);
}

const worker = {
  async fetch(request, rawEnv) {
    try { return await handleRequest(request, rawEnv); }
    catch (error) {
      console.error('bot request failed');
      const message = String(error?.message || 'Worker কাজ শেষ করতে পারেনি।');
      const known = /^(KV_MISSING|সঠিক JSON|অনুরোধের তথ্য|Telegram-এর সংযোগের অবস্থা)/.test(message);
      return json({ ok: false, error: known ? message : 'Worker-এর সংরক্ষণ বা নেটওয়ার্কে সমস্যা। Cloudflare-এর KV binding, সীমা ও লগ দেখুন।' }, 500);
    }
  },
};

export default worker;
export const route = (request, env) => worker.fetch(request, env);