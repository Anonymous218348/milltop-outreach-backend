'use strict';

const express = require('express');
const axios = require('axios');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { normalizeUrl } = require('../utils/url');
const { runPageSpeed } = require('../services/pagespeed.service');
const { findEmailForDomain } = require('../services/finder.service');
const { getApiKey, getSettings } = require('../services/settings.service');
const { runDeepAudit } = require('../services/deep-audit.service');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10);
const TELEGRAM_ACCOUNT_EMAIL = process.env.TELEGRAM_ACCOUNT_EMAIL;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Escape Telegram legacy-Markdown special characters in dynamic/scraped text
// so a stray "_" or "*" in an email, domain, or DB value can't break parse_mode.
const escapeMd = (str = '') => String(str).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

// Send message to Telegram. Falls back to a plain-text retry (stripped of
// Markdown characters) if the formatted send fails, so the user always gets
// a reply instead of silent failure.
const sendMessage = async (chatId, text, options = {}) => {
  try {
    await axios.post(`${API_URL}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...options
    });
  } catch (e) {
    console.error('Telegram send error:', e.message);
    try {
      await axios.post(`${API_URL}/sendMessage`, {
        chat_id: chatId,
        text: text.replace(/[*_`[\]]/g, '')
      });
    } catch (e2) {
      console.error('Telegram fallback send also failed:', e2.message);
    }
  }
};

// This bot token is configured for one Telegram operator. Bind it to an
// explicit account so multi-user deployments never operate on an arbitrary user.
const getUser = async () => {
  if (!TELEGRAM_ACCOUNT_EMAIL) throw new Error('Telegram bot account is not configured');
  const { rows } = await db.query('SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1', [TELEGRAM_ACCOUNT_EMAIL]);
  if (!rows[0]) throw new Error('Configured Telegram account was not found');
  return rows[0] || null;
};

// Format score with emoji
const formatFinding = (finding) => `${finding.title}${finding.displayValue ? ` — ${finding.displayValue}` : ''}`;

const scoreEmoji = (score) => {
  if (score === null || score === undefined) return '❓ N/A';
  if (score >= 90) return `🟢 ${score}`;
  if (score >= 70) return `🟡 ${score}`;
  return `🔴 ${score}`;
};

// Handle incoming Telegram messages
const handleMessage = async (message) => {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  // Security check
  if (userId !== ALLOWED_USER_ID) {
    await sendMessage(chatId, '⛔ Unauthorized access.');
    return;
  }

  const lower = text.toLowerCase();

  // ── HELP ──────────────────────────────────────────────────────
  if (lower === '/start' || lower === '/help') {
    await sendMessage(chatId, `
*🚀 MILLTOP TECH Bot*

Here's what I can do:

*Scanner*
/scan https://store.com — Scan a website
/deep https://store.com — Deep store audit
/bulkscan — Scan up to 500 URLs at once (one per line)

*Email Finder*
/find https://store.com — Find contact email

*Contacts*
/contacts — List all contacts
/addcontact email@example.com — Add a contact

*Tracker*
/tracker — View outreach tracker

*Campaigns*
/campaigns — List campaigns

*AI Assistant*
/ai your question here — Ask the AI

*Stats*
/stats — View platform stats

Just send me a URL and I'll scan it automatically!
    `.trim());
    return;
  }

  // ── AUTO SCAN if just a URL is sent ───────────────────────────
  if ((lower.startsWith('http://') || lower.startsWith('https://')) && !lower.includes(' ') && !lower.includes('\n')) {
    await handleScan(chatId, text);
    return;
  }

  // ── SCAN ──────────────────────────────────────────────────────
  if (lower.startsWith('/scan ') || lower.startsWith('/scan\n')) {
    const url = text.split(/\s+/)[1];
    if (!url) { await sendMessage(chatId, '❌ Please provide a URL. Example: /scan https://store.com'); return; }
    await handleScan(chatId, url);
    return;
  }

  // ── DEEP AUDIT ───────────────────────────────────────────────
  if (lower.startsWith('/deep ') || lower.startsWith('/deep\n')) {
    const url = text.split(/\s+/)[1];
    if (!url) {
      await sendMessage(chatId, '❌ Please provide a URL. Example: /deep https://store.com');
      return;
    }
    await handleDeepAudit(chatId, url);
    return;
  }

  // ── BULK SCAN (handles up to 500 URLs) ────────────────────────
  if (lower.startsWith('/bulkscan')) {
    const body = text.replace(/^\/bulkscan/i, '').trim();
    const urls = body.split(/[\n,]+/).map(u => u.trim()).filter(u => u.toLowerCase().startsWith('http'));

    if (urls.length === 0) {
      await sendMessage(chatId, '❌ Paste your URLs after /bulkscan, one per line. Example:\n\n/bulkscan\nhttps://store1.com\nhttps://store2.com');
      return;
    }

    if (urls.length > 500) {
      await sendMessage(chatId, `❌ Max 500 URLs at once. You sent ${urls.length}. Trim the list and try again.`);
      return;
    }

    await handleBulkScan(chatId, urls);
    return;
  }

  // ── FIND EMAIL ────────────────────────────────────────────────
  if (lower.startsWith('/find ')) {
    const url = text.split(/\s+/)[1];
    if (!url) { await sendMessage(chatId, '❌ Please provide a URL. Example: /find https://store.com'); return; }
    await handleFind(chatId, url);
    return;
  }

  // ── CONTACTS ─────────────────────────────────────────────────
  if (lower === '/contacts') {
    await handleContacts(chatId);
    return;
  }

  if (lower.startsWith('/addcontact ')) {
    const email = text.split(/\s+/)[1];
    await handleAddContact(chatId, email);
    return;
  }

  // ── TRACKER ──────────────────────────────────────────────────
  if (lower === '/tracker') {
    await handleTracker(chatId);
    return;
  }

  // ── CAMPAIGNS ────────────────────────────────────────────────
  if (lower === '/campaigns') {
    await handleCampaigns(chatId);
    return;
  }

  // ── STATS ────────────────────────────────────────────────────
  if (lower === '/stats') {
    await handleStats(chatId);
    return;
  }

  // ── AI ───────────────────────────────────────────────────────
  if (lower.startsWith('/ai ')) {
    const question = text.substring(4).trim();
    await handleAI(chatId, question);
    return;
  }

  // ── DEFAULT ──────────────────────────────────────────────────
  await sendMessage(chatId, '❓ I didn\'t understand that. Send /help to see what I can do.');
};

// ── HANDLERS ──────────────────────────────────────────────────────

const handleScan = async (chatId, input) => {
  await sendMessage(chatId, `🔍 Scanning *${escapeMd(input)}*...\n_This takes 15-30 seconds_`);
  try {
    const user = await getUser();
    if (!user) { await sendMessage(chatId, '❌ No user found in database.'); return; }

    const url = normalizeUrl(input).replace(/[\\/]+$/, '');
    const apiKey = await getApiKey(user.id, 'pagespeed_api_key', 'PAGESPEED_API_KEY');

    const [mobile, desktop] = await Promise.all([
      runPageSpeed(url, 'mobile', apiKey),
      runPageSpeed(url, 'desktop', apiKey)
    ]);

    const { rows } = await db.query(
      `INSERT INTO stores (user_id, url, mobile_performance, desktop_performance, mobile_seo, desktop_seo,
        mobile_best_practices, desktop_best_practices, mobile_accessibility, desktop_accessibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, url) DO UPDATE SET
         mobile_performance = EXCLUDED.mobile_performance,
         desktop_performance = EXCLUDED.desktop_performance,
         mobile_seo = EXCLUDED.mobile_seo,
         desktop_seo = EXCLUDED.desktop_seo,
         mobile_best_practices = EXCLUDED.mobile_best_practices,
         desktop_best_practices = EXCLUDED.desktop_best_practices,
         mobile_accessibility = EXCLUDED.mobile_accessibility,
         desktop_accessibility = EXCLUDED.desktop_accessibility
       RETURNING *`,
      [user.id, url, mobile.performance, desktop.performance, mobile.seo, desktop.seo,
       mobile.bestPractices, desktop.bestPractices, mobile.accessibility, desktop.accessibility]
    );

    const store = rows[0];
    const domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];

    await sendMessage(chatId, `
✅ *Scan Complete: ${escapeMd(domain)}*

📱 *Mobile*
Performance: ${scoreEmoji(store.mobile_performance)}
SEO: ${scoreEmoji(store.mobile_seo)}
Best Practices: ${scoreEmoji(store.mobile_best_practices)}
Accessibility: ${scoreEmoji(store.mobile_accessibility)}

🖥 *Desktop*
Performance: ${scoreEmoji(store.desktop_performance)}
SEO: ${scoreEmoji(store.desktop_seo)}

⚠️ Lighthouse scores are screening signals only. Use the website itself to verify a concrete issue before outreach.

Top Lighthouse findings:\n${(mobile.findings || []).slice(0, 3).map(f => `• ${escapeMd(formatFinding(f))}`).join('\n') || '• No major automated findings returned.'}\n\nUse /find ${input} to find their email.
    `.trim());
  } catch (e) {
    await sendMessage(chatId, `❌ Scan failed: ${escapeMd(e.message)}`);
  }
};

const handleDeepAudit = async (chatId, input) => {
  await sendMessage(chatId, '🔎 Deep auditing ' + input + '...\nChecking the homepage and key catalog pages.', { parse_mode: undefined });
  try {
    const user = await getUser();
    if (!user) {
      await sendMessage(chatId, '❌ No user found in database.', { parse_mode: undefined });
      return;
    }

    const url = normalizeUrl(input).replace(/[\\/]+$/, '');
    const audit = await runDeepAudit(url);

    await db.query(
      'INSERT INTO stores (user_id, url, deep_findings, deep_priority, deep_scanned_at) ' +
      'VALUES ($1, $2, $3, $4, NOW()) ' +
      'ON CONFLICT (user_id, url) DO UPDATE SET ' +
      'deep_findings = EXCLUDED.deep_findings, ' +
      'deep_priority = EXCLUDED.deep_priority, ' +
      'deep_scanned_at = EXCLUDED.deep_scanned_at',
      [user.id, url, JSON.stringify(audit.findings), audit.priority]
    );

    const findings = audit.findings.slice(0, 8).map((f, i) =>
      (i + 1) + '. ' + f.severity.toUpperCase() + ' — ' + f.title +
      '\n   ' + f.evidence +
      '\n   ' + f.url
    ).join('\n\n');

    await sendMessage(chatId, [
      '🔎 Deep Audit: ' + url,
      '',
      'Priority: ' + audit.priority,
      'Pages checked: ' + audit.pages,
      '',
      'Findings',
      findings || 'No concrete issues found by the automated checks.'
    ].join('\n'), { parse_mode: undefined });
  } catch (e) {
    await sendMessage(chatId, '❌ Deep audit failed: ' + e.message, { parse_mode: undefined });
  }
};

// ── BULK SCAN HANDLER (up to 500 URLs, sequential with progress) ──
const handleBulkScan = async (chatId, urls) => {
  const total = urls.length;
  await sendMessage(chatId, `🔍 Starting bulk scan of *${total} stores*...\n_Progress updates every 20 stores. This will take a while._`);

  const user = await getUser();
  if (!user) { await sendMessage(chatId, '❌ No user found in database.'); return; }

  const apiKey = await getApiKey(user.id, 'pagespeed_api_key', 'PAGESPEED_API_KEY');

  let scanned = 0;
  let flagged = 0;
  let failed = 0;

  for (const input of urls) {
    try {
      const url = normalizeUrl(input).replace(/[\\/]+$/, '');

      const [mobile, desktop] = await Promise.all([
        runPageSpeed(url, 'mobile', apiKey),
        runPageSpeed(url, 'desktop', apiKey)
      ]);

      const { rows } = await db.query(
        `INSERT INTO stores (user_id, url, mobile_performance, desktop_performance, mobile_seo, desktop_seo,
          mobile_best_practices, desktop_best_practices, mobile_accessibility, desktop_accessibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [user.id, url, mobile.performance, desktop.performance, mobile.seo, desktop.seo,
         mobile.bestPractices, desktop.bestPractices, mobile.accessibility, desktop.accessibility]
      );

      const store = rows[0];
      const domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];

      scanned++;
    } catch (e) {
      failed++;
      console.error(`Bulk scan failed for ${input}:`, e.message);
    }

    if (scanned % 20 === 0 || scanned + failed === total) {
      await sendMessage(chatId, `📊 Progress: ${scanned + failed}/${total} scanned (${failed} failed)`);
    }

    // Small delay to avoid hammering PageSpeed API and Telegram rate limits
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  const summary = `
✅ *Bulk Scan Complete*

📦 Total: ${total}
✅ Scanned: ${scanned}
🎯 Automated target flags: disabled
❌ Failed: ${failed}
  `.trim();

  await sendMessage(chatId, summary);

};

const handleFind = async (chatId, input) => {
  await sendMessage(chatId, `📧 Finding email for *${escapeMd(input)}*...\n_Searching contact pages..._`);
  try {
    const user = await getUser();
    if (!user) { await sendMessage(chatId, '❌ No user found.'); return; }

    const hunterKey = await getApiKey(user.id, 'hunter_api_key', 'HUNTER_API_KEY');
    const result = await findEmailForDomain(input, hunterKey);

    if (result.email) {
      // Save to store
      const url = normalizeUrl(input);
      await db.query(
        `UPDATE stores SET contact_email=$1, email_source=$2, email_status=$3 
         WHERE user_id=$4 AND url LIKE $5`,
        [result.email, result.source, result.status, user.id, `%${url}%`]
      );

      await sendMessage(chatId, `
✅ *Email Found!*

📧 ${escapeMd(result.email)}
🔍 Source: ${escapeMd(result.source)}
🌐 Domain: ${escapeMd(input)}

Reply with this email to add them as a contact!
      `.trim());
    } else {
      await sendMessage(chatId, `❌ No email found for *${escapeMd(input)}*\n\nTry entering it manually in the app.`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleContacts = async (chatId) => {
  try {
    const user = await getUser();
    const { rows } = await db.query(
      'SELECT * FROM contacts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
      [user.id]
    );
    if (rows.length === 0) {
      await sendMessage(chatId, '📭 No contacts yet. Use /addcontact to add one.');
      return;
    }
    const list = rows.map((c, i) =>
      `${i + 1}. *${escapeMd(c.name || c.domain || 'Unknown')}*\n   📧 ${escapeMd(c.email)}\n   Stage: ${escapeMd(c.outreach_stage || 'lead')}`
    ).join('\n\n');
    await sendMessage(chatId, `📋 *Your Contacts (last 10)*\n\n${list}`);
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleAddContact = async (chatId, email) => {
  if (!email || !email.includes('@')) {
    await sendMessage(chatId, '❌ Please provide a valid email. Example: /addcontact hello@store.com');
    return;
  }
  try {
    const user = await getUser();
    await db.query(
      `INSERT INTO contacts (user_id, email, outreach_stage, status)
       VALUES ($1, $2, 'lead', 'new')`,
      [user.id, email]
    );
    await sendMessage(chatId, `✅ Contact *${escapeMd(email)}* added successfully!`);
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleTracker = async (chatId) => {
  try {
    const user = await getUser();
    const { rows } = await db.query(
      'SELECT * FROM tracker WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
      [user.id]
    );
    if (rows.length === 0) {
      await sendMessage(chatId, '📭 No tracker entries yet.');
      return;
    }
    const list = rows.map((e, i) =>
      `${i + 1}. *${escapeMd(e.store_name || e.website || 'Unknown')}*\n   Status: ${escapeMd(e.status || 'New')}\n   Email: ${escapeMd(e.email || 'N/A')}`
    ).join('\n\n');
    await sendMessage(chatId, `📊 *Outreach Tracker (last 10)*\n\n${list}`);
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleCampaigns = async (chatId) => {
  try {
    const user = await getUser();
    const { rows } = await db.query(
      'SELECT * FROM campaigns WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10',
      [user.id]
    );
    if (rows.length === 0) {
      await sendMessage(chatId, '📭 No campaigns yet. Create one in the app.');
      return;
    }
    const list = rows.map((c, i) =>
      `${i + 1}. *${escapeMd(c.name)}*\n   Status: ${escapeMd(c.status || 'draft')}`
    ).join('\n\n');
    await sendMessage(chatId, `📣 *Your Campaigns*\n\n${list}`);
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleStats = async (chatId) => {
  try {
    const user = await getUser();
    const [stores, contacts, campaigns, tracker, emails] = await Promise.all([
      db.query('SELECT COUNT(*) FROM stores WHERE user_id=$1', [user.id]),
      db.query('SELECT COUNT(*) FROM contacts WHERE user_id=$1', [user.id]),
      db.query('SELECT COUNT(*) FROM campaigns WHERE user_id=$1', [user.id]),
      db.query('SELECT COUNT(*) FROM tracker WHERE user_id=$1', [user.id]),
      db.query('SELECT COUNT(*) FROM email_logs WHERE user_id=$1', [user.id])
    ]);
    await sendMessage(chatId, `
📊 *MILLTOP TECH Stats*

🏪 Stores Scanned: *${stores.rows[0].count}*
👥 Contacts: *${contacts.rows[0].count}*
📣 Campaigns: *${campaigns.rows[0].count}*
📋 Tracker Entries: *${tracker.rows[0].count}*
📧 Emails Sent: *${emails.rows[0].count}*
    `.trim());
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${escapeMd(e.message)}`);
  }
};

const handleAI = async (chatId, question) => {
  if (!question) { await sendMessage(chatId, '❌ Please add a question. Example: /ai write me a cold email'); return; }
  await sendMessage(chatId, '🤖 Thinking...');
  try {
    const user = await getUser();
    const groqKey = await getApiKey(user.id, 'groq_api_key', 'GROQ_API_KEY');
    if (!groqKey) { await sendMessage(chatId, '❌ No Groq API key set. Add it in Settings.'); return; }

    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are MILLTOP TECH AI assistant. Help with cold email outreach, web optimization, and sales. Be concise and actionable. Keep responses under 300 words.' },
        { role: 'user', content: question }
      ],
      temperature: 0.7,
      max_tokens: 400
    }, {
      headers: { Authorization: `Bearer ${groqKey}` },
      timeout: 30000
    });

    const reply = data.choices[0].message.content;
    // AI output is free-form and may contain stray Markdown chars (e.g. "_" in
    // an email address it suggests), so escape it before sending.
    await sendMessage(chatId, `🤖 *AI Response*\n\n${escapeMd(reply)}`);
  } catch (e) {
    await sendMessage(chatId, `❌ AI error: ${escapeMd(e.message)}`);
  }
};

// ── WEBHOOK ENDPOINT ──────────────────────────────────────────────
router.post('/webhook', (req, res, next) => {
  if (!WEBHOOK_SECRET || req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  next();
}, asyncHandler(async (req, res) => {
  res.sendStatus(200); // Always respond to Telegram immediately
  const { message } = req.body;
  if (message) {
    handleMessage(message).catch(console.error);
  }
}));

// ── SET WEBHOOK ───────────────────────────────────────────────────
router.get('/setup', requireAuth, asyncHandler(async (req, res) => {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ message: 'Set TELEGRAM_WEBHOOK_SECRET before configuring the webhook' });
  }
  const webhookUrl = `${process.env.APP_URL}/api/telegram/webhook`;
  const { data } = await axios.post(`${API_URL}/setWebhook`, { url: webhookUrl, secret_token: WEBHOOK_SECRET });
  res.json(data);
}));

module.exports = router;
