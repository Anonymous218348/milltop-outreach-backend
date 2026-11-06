const express = require('express');
const { body, param } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { findEmailForDomain } = require('../services/finder.service');
const { getApiKey } = require('../services/settings.service');
const { normalizeUrl, domainKeyFromUrl } = require('../utils/url');
 
const router = express.Router();
router.use(requireAuth);
 
const updateOrCreateStore = async (userId, domain, result) => {
  const url = normalizeUrl(domain);
  const domainKey = domainKeyFromUrl(url);
 
  // Prefer the row that already has performance scores — this avoids
  // overwriting a scanned row's scores with a new empty row.
  // If multiple rows exist for the same URL, pick the one with scores first.
  const existing = await db.query(
    `SELECT * FROM stores 
     WHERE user_id = $1 AND (domain_key = $2 OR (domain_key IS NULL AND lower(regexp_replace(substring(url from '^https?://([^/:?#]+)'), '^www\\.', '')) = $2))
     ORDER BY 
       CASE WHEN mobile_performance IS NOT NULL THEN 0 ELSE 1 END,
       created_at DESC 
     LIMIT 1`,
    [userId, domainKey]
  );
 
  if (existing.rows[0]) {
    // Update email on the correct row (the one with scores)
    const { rows } = await db.query(
      `UPDATE stores SET contact_email = $1, email_source = $2, email_status = $3, flagged = $4
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [result.email, result.source, result.status, result.flagged, existing.rows[0].id, userId]
    );
 
    // Clean up any duplicate rows for this URL that have no scores
    await db.query(
      `DELETE FROM stores 
       WHERE user_id = $1 AND domain_key = $2 AND id != $3
       AND mobile_performance IS NULL AND desktop_performance IS NULL`,
      [userId, domainKey, existing.rows[0].id]
    );
 
    return rows[0];
  }
 
  // No existing row — create one
  const { rows } = await db.query(
    `INSERT INTO stores (user_id, url, domain_key, contact_email, email_source, email_status, flagged)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, url, domainKey, result.email, result.source, result.status, result.flagged]
  );
  return rows[0];
};
 
router.post('/find',
  body('domain').notEmpty(),
  validate,
  asyncHandler(async (req, res) => {
    const hunterApiKey = await getApiKey(req.user.id, 'hunter_api_key', 'HUNTER_API_KEY');
    const result = await findEmailForDomain(req.body.domain, hunterApiKey);
    const store = await updateOrCreateStore(req.user.id, req.body.domain, result);
    res.json({ store });
  })
);
 
router.post('/bulk',
  body('domains').isArray({ min: 1, max: 100 }),
  body('domains.*').notEmpty(),
  validate,
  asyncHandler(async (req, res) => {
    const hunterApiKey = await getApiKey(req.user.id, 'hunter_api_key', 'HUNTER_API_KEY');
    const results = [];
    for (const domain of req.body.domains) {
      const result = await findEmailForDomain(domain, hunterApiKey);
      const store = await updateOrCreateStore(req.user.id, domain, result);
      results.push(store);
    }
    res.json({ stores: results });
  })
);
 
router.put('/:id/manual',
  param('id').isUUID(),
  body('email').isEmail().normalizeEmail(),
  validate,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE stores SET contact_email = $1, email_source = 'Manual', email_status = 'Found', flagged = false
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [req.body.email, req.params.id, req.user.id]
    );
    res.json({ store: rows[0] || null });
  })
);
 
module.exports = router;
 
































































