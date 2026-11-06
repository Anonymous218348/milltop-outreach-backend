const express = require('express');
const { body } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { normalizeUrl, domainKeyFromUrl } = require('../utils/url');
const { runPageSpeed } = require('../services/pagespeed.service');
const { getApiKey } = require('../services/settings.service');
const { requestPublicUrl } = require('../utils/safeFetch');
const cheerio = require('cheerio');


const { runDeepAudit } = require('../services/deep-audit.service');
const router = express.Router();
router.use(requireAuth);

const isSiteAlive = async (url) => {
  try {
    const res = await requestPublicUrl(url, {
      method: 'HEAD',
      timeout: 5000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MILLTOPTECHBot/1.0)' }
    });
    return res.status < 500;
  } catch {
    try {
      const res = await requestPublicUrl(url, {
        method: 'GET',
        timeout: 5000,
        maxRedirects: 3,
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MILLTOPTECHBot/1.0)' }
      });
      res.data.destroy();
      return res.status < 500;
    } catch {
      return false;
    }
  }
};

const scanSingleUrl = async (url, apiKey, userId) => {
  try {
    const alive = await isSiteAlive(url);
    if (!alive) {
      return { success: false, url, error: 'Site unreachable — skipped' };
    }
    const [mobile, desktop] = await Promise.all([
      runPageSpeed(url, 'mobile', apiKey),
      runPageSpeed(url, 'desktop', apiKey)
    ]);

    // Use UPSERT so re-scanning a URL always updates scores instead of
    // silently skipping (ON CONFLICT DO NOTHING caused N/A on refresh).
    const { rows } = await db.query(
      `INSERT INTO stores (
        user_id, url, domain_key, mobile_performance, desktop_performance, mobile_seo, desktop_seo,
        mobile_best_practices, desktop_best_practices, mobile_accessibility, desktop_accessibility
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (user_id, url) DO UPDATE SET
        mobile_performance = EXCLUDED.mobile_performance,
        desktop_performance = EXCLUDED.desktop_performance,
        mobile_seo = EXCLUDED.mobile_seo,
        desktop_seo = EXCLUDED.desktop_seo,
        mobile_best_practices = EXCLUDED.mobile_best_practices,
        desktop_best_practices = EXCLUDED.desktop_best_practices,
        mobile_accessibility = EXCLUDED.mobile_accessibility,
        desktop_accessibility = EXCLUDED.desktop_accessibility,
        domain_key = EXCLUDED.domain_key,
        created_at = NOW()
      RETURNING *`,
      [
        userId, url, domainKeyFromUrl(url),
        mobile.performance, desktop.performance,
        mobile.seo, desktop.seo,
        mobile.bestPractices, desktop.bestPractices,
        mobile.accessibility, desktop.accessibility
      ]
    );
    return { success: true, data: rows[0] };
  } catch (err) {
    return { success: false, url, error: err.message };
  }
};

router.post('/scan',
  body('urls').optional().isArray({ min: 1, max: 500 }),
  body('urls.*').optional().isURL({ require_protocol: false }),
  body('url').optional().isURL({ require_protocol: false }),
  body('urls').custom((value, { req }) => {
    const input = value || req.body.url;
    if (Array.isArray(input)) return input.length > 0 && input.every(Boolean);
    return Boolean(input);
  }),
  validate,
  asyncHandler(async (req, res) => {
    const input = req.body.urls || req.body.url;
    const urls = (Array.isArray(input) ? input : [input]).map(normalizeUrl);
    const apiKey = await getApiKey(req.user.id, 'pagespeed_api_key', 'PAGESPEED_API_KEY');
    const BATCH_SIZE = 5;
    const results = [];
    const skipped = [];
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(url => scanSingleUrl(url, apiKey, req.user.id))
      );
      for (const r of batchResults) {
        if (r.success && r.data) results.push(r.data);
        else skipped.push({ url: r.url, reason: r.error });
      }
    }
    res.status(201).json({ results, skipped });
  })
);


router.post('/deep', body('url').isURL(), validate, asyncHandler(async (req, res) => {
  const url = normalizeUrl(req.body.url).replace(/\/$/, '');
  const audit = await runDeepAudit(url);
  const { rows } = await db.query(
    `INSERT INTO stores (user_id,url,deep_findings,deep_priority,deep_scanned_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (user_id,url) DO UPDATE SET deep_findings=EXCLUDED.deep_findings, deep_priority=EXCLUDED.deep_priority, deep_scanned_at=NOW()
     RETURNING *`, [req.user.id,url,JSON.stringify(audit.findings),audit.priority]
  );
  res.json({ store: rows[0], audit });
}));

// Returns ALL scanned stores — scanner tab shows everything.
// Only the Email Sender tab filters sent stores (done on frontend).
router.get('/results', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM stores WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ stores: rows });
}));

// Clear ALL scan results for this user permanently
router.delete('/results/all', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM stores WHERE user_id = $1', [req.user.id]);
  res.sendStatus(204);
}));

// Delete a single scanned store permanently
router.delete('/:id', asyncHandler(async (req, res) => {
  await db.query('DELETE FROM stores WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.sendStatus(204);
}));

module.exports = router;
