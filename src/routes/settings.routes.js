const express = require('express');
const { body } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { getSettings, normalizeGmailAccounts } = require('../services/settings.service');
const router = express.Router();
router.use(requireAuth);

const withoutSmtpPasswords = (settings) => {
  if (!settings) return settings;
  const gmailAccounts = normalizeGmailAccounts(settings.gmail_accounts)
    .filter(account => account.email)
    .map((account) => ({ email: account.email }));
  return { ...settings, gmail_accounts: gmailAccounts };
};

router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json({
    settings: withoutSmtpPasswords(settings) || {
      pagespeed_api_key: null,
      hunter_api_key: null,
      groq_api_key: null,
      sendgrid_api_key: null,
      sendgrid_from: null,
      sendgrid_name: null,
      sendgrid_template_id: null,
      mailgun_api_key: null,
      mailgun_domain: null,
      mailgun_from: null,
      email_provider: 'gmail',
      gmail_accounts: []
    }
  });
}));

router.post('/',
  body('gmailAccounts').optional().isArray(),
  body('emailProvider').optional().isIn(['gmail','sendgrid','mailgun']),
  body('sendDelay').optional().isInt({ min: 1, max: 60 }),
  validate,
  asyncHandler(async (req, res) => {
    const current = await db.query('SELECT gmail_accounts,email_provider FROM user_settings WHERE user_id=$1', [req.user.id]);
    const oldAccounts = normalizeGmailAccounts(current.rows[0]?.gmail_accounts);
    const oldByEmail = new Map(oldAccounts.map(account => [String(account.email || '').toLowerCase(), account]));
    const requestedAccounts = Array.isArray(req.body.gmailAccounts) ? req.body.gmailAccounts : oldAccounts;
    const emailProvider = req.body.emailProvider || current.rows[0]?.email_provider || 'gmail';
    const gmailAccounts = requestedAccounts.map(account => ({
      email: account.email,
      pass: account.pass || oldByEmail.get(String(account.email || '').toLowerCase())?.pass || ''
    }));
    const { rows } = await db.query(
      `INSERT INTO user_settings (
        user_id, pagespeed_api_key, hunter_api_key, groq_api_key,
        sendgrid_api_key, sendgrid_from, sendgrid_name, sendgrid_template_id,
        mailgun_api_key, mailgun_domain, mailgun_from, email_provider, gmail_accounts, send_delay
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (user_id)
      DO UPDATE SET
        pagespeed_api_key=$2, hunter_api_key=$3, groq_api_key=$4,
        sendgrid_api_key=$5, sendgrid_from=$6, sendgrid_name=$7,
        sendgrid_template_id=$8,
        mailgun_api_key=$9, mailgun_domain=$10, mailgun_from=$11,
        email_provider=$12, gmail_accounts=$13, send_delay=$14, updated_at=NOW()
      RETURNING *`,
      [
        req.user.id,
        req.body.pagespeedApiKey || null,
        req.body.hunterApiKey || null,
        req.body.groqApiKey || null,
        req.body.sendgridApiKey || null,
        req.body.sendgridFrom || null,
        req.body.sendgridName || null,
        req.body.sendgridTemplateId || null,
        req.body.mailgunApiKey || null,
        req.body.mailgunDomain || null,
        req.body.mailgunFrom || null,
        emailProvider,
        JSON.stringify(gmailAccounts),
        Math.min(60, Math.max(1, Number.parseInt(req.body.sendDelay, 10) || 3))
      ]
    );
    res.json({ settings: withoutSmtpPasswords(rows[0]) });
  })
);

module.exports = router;
