const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth);

router.get('/overview', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
      (SELECT COUNT(*)::int FROM stores WHERE user_id=$1) AS total_stores_scanned,
      (SELECT COUNT(*)::int FROM email_logs WHERE user_id=$1 AND status='sent') AS emails_sent,
      (SELECT COUNT(*)::int FROM email_logs WHERE user_id=$1 AND replied_at IS NOT NULL) AS replies,
      (SELECT COUNT(*)::int FROM contacts WHERE user_id=$1 AND lower(outreach_stage) IN ('converted','closed','won')) AS conversions`,
    [req.user.id]
  );
  const overview = rows[0];
  overview.reply_rate = overview.emails_sent ? overview.replies / overview.emails_sent : 0;
  overview.conversion_rate = overview.emails_sent ? overview.conversions / overview.emails_sent : 0;
  res.json({ overview });
}));

router.get('/campaigns', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.name,
      COUNT(el.id)::int AS total_emails,
      COUNT(el.id) FILTER (WHERE el.status='sent')::int AS sent,
      COUNT(el.id) FILTER (WHERE el.opened_at IS NOT NULL)::int AS opened,
      COUNT(el.id) FILTER (WHERE el.replied_at IS NOT NULL)::int AS replied
     FROM campaigns c
     LEFT JOIN email_logs el ON el.campaign_id = c.id
     WHERE c.user_id=$1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({ campaigns: rows });
}));

module.exports = router;
