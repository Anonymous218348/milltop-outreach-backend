const express = require('express');
const { body, param } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { personalize, sendOne, sendBulk } = require('../services/email.service');
const { getGmailAccounts } = require('../services/settings.service');

const router = express.Router();
router.use(requireAuth);

router.post('/send',
  body('to').isEmail().normalizeEmail(),
  body('subject').notEmpty(),
  body('body').notEmpty(),
  validate,
  asyncHandler(async (req, res) => {
    // Merge explicit data blob with top-level storeName/domain fields so
    // personalize() can replace all placeholder formats in the template.
    const data = {
      ...(req.body.data || {}),
      name: req.body.storeName || req.body.data?.name || '',
      storeName: req.body.storeName || req.body.data?.storeName || '',
      domain: req.body.storeName || req.body.data?.domain || '',
    };
    const log = await sendOne({
      userId: req.user.id,
      to: req.body.to,
      subject: personalize(req.body.subject, data),
      body: personalize(req.body.body, data),
      storeId: req.body.storeId,
      contactId: req.body.contactId,
      campaignId: req.body.campaignId,
      storeName: req.body.storeName || null,
      fromAccount: req.body.fromAccount,
    });
    res.json({ log });
  })
);

router.post('/bulk',
  body('contacts').isArray({ min: 1, max: 500 }),
  body('subject').notEmpty(),
  body('body').notEmpty(),
  body('delayMs').optional().isInt({ min: 0 }),
  validate,
  asyncHandler(async (req, res) => {
    const accounts = await getGmailAccounts(req.user.id);
    const results = await sendBulk({
      userId: req.user.id,
      contacts: req.body.contacts,
      subject: req.body.subject,
      body: req.body.body,
      delayMs: req.body.delayMs || 500,
      accounts,
      campaignId: req.body.campaignId
    });
    res.json({ results });
  })
);

router.get('/logs', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM email_logs WHERE user_id=$1 ORDER BY COALESCE(sent_at, NOW()) DESC',
    [req.user.id]
  );
  res.json({ logs: rows });
}));

// Delete a single email log entry permanently
router.delete('/logs/:id', asyncHandler(async (req, res) => {
  await db.query(
    'DELETE FROM email_logs WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  res.sendStatus(204);
}));

router.post('/log',
  body('toEmail').isEmail().normalizeEmail(),
  body('subject').notEmpty(),
  validate,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `INSERT INTO email_logs (user_id, subject, status, store_name, to_email, provider, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        req.user.id,
        req.body.subject,
        (req.body.status || 'sent').toLowerCase(),
        req.body.storeName || null,
        req.body.toEmail,
        req.body.provider || null
      ]
    );
    res.status(201).json({ log: rows[0] });
  })
);

module.exports = router;
