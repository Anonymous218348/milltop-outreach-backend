const express = require('express');
const { body, param } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { getGmailAccounts } = require('../services/settings.service');
const { sendBulk } = require('../services/email.service');
const { HttpError } = require('../utils/httpError');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(json_agg(cc.contact_id) FILTER (WHERE cc.contact_id IS NOT NULL), '[]') AS contact_ids
     FROM campaigns c
     LEFT JOIN campaign_contacts cc ON cc.campaign_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [req.user.id]
  );
  res.json({ campaigns: rows });
}));

router.post('/',
  body('name').notEmpty(),
  body('templateId').optional({ nullable: true }).isUUID(),
  body('contactIds').optional().isArray(),
  body('contactIds.*').optional().isUUID(),
  validate,
  asyncHandler(async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (req.body.templateId) {
        const template = await client.query('SELECT id FROM templates WHERE id=$1 AND user_id=$2', [req.body.templateId, req.user.id]);
        if (!template.rows[0]) throw new HttpError(400, 'Template not found for this account');
      }
      const contactIds = [...new Set(req.body.contactIds || [])];
      if (contactIds.length) {
        const ownedContacts = await client.query('SELECT id FROM contacts WHERE user_id=$1 AND id=ANY($2::uuid[])', [req.user.id, contactIds]);
        if (ownedContacts.rowCount !== contactIds.length) throw new HttpError(400, 'One or more contacts do not belong to this account');
      }
      const campaignResult = await client.query(
        `INSERT INTO campaigns (user_id, name, template_id, status, scheduled_at)
         VALUES ($1,$2,$3,COALESCE($4,'draft'),$5) RETURNING *`,
        [req.user.id, req.body.name, req.body.templateId || null, req.body.status || null, req.body.scheduledAt || null]
      );
      for (const contactId of contactIds) {
        await client.query(
          `INSERT INTO campaign_contacts (campaign_id, contact_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [campaignResult.rows[0].id, contactId]
        );
      }
      const campaign = { ...campaignResult.rows[0], contact_ids: contactIds };
      await client.query('COMMIT');
      res.status(201).json({ campaign });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })
);

router.put('/:id',
  param('id').isUUID(),
  body('templateId').optional({ nullable: true }).isUUID(),
  body('contactIds').optional().isArray(),
  body('contactIds.*').optional().isUUID(),
  validate,
  asyncHandler(async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
      if (!current.rows[0]) throw new HttpError(404, 'Campaign not found');
      const campaign = { ...current.rows[0], ...req.body };
      if (campaign.templateId) {
        const template = await client.query('SELECT id FROM templates WHERE id=$1 AND user_id=$2', [campaign.templateId, req.user.id]);
        if (!template.rows[0]) throw new HttpError(400, 'Template not found for this account');
      }
      const { rows } = await client.query(
        `UPDATE campaigns SET name=$1, template_id=$2, status=$3, scheduled_at=$4
         WHERE id=$5 AND user_id=$6 RETURNING *`,
        [campaign.name, campaign.templateId || campaign.template_id || null, campaign.status || 'draft', campaign.scheduledAt || campaign.scheduled_at || null, req.params.id, req.user.id]
      );
      if (Array.isArray(req.body.contactIds)) {
        const contactIds = [...new Set(req.body.contactIds)];
        if (contactIds.length) {
          const ownedContacts = await client.query('SELECT id FROM contacts WHERE user_id=$1 AND id=ANY($2::uuid[])', [req.user.id, contactIds]);
          if (ownedContacts.rowCount !== contactIds.length) throw new HttpError(400, 'One or more contacts do not belong to this account');
        }
        await client.query('DELETE FROM campaign_contacts WHERE campaign_id=$1', [req.params.id]);
        for (const contactId of contactIds) {
          await client.query('INSERT INTO campaign_contacts (campaign_id, contact_id) VALUES ($1,$2)', [req.params.id, contactId]);
        }
      }
      await client.query('COMMIT');
      const ids = Array.isArray(req.body.contactIds)
        ? [...new Set(req.body.contactIds)]
        : (await client.query('SELECT contact_id FROM campaign_contacts WHERE campaign_id=$1', [req.params.id])).rows.map(row => row.contact_id);
      res.json({ campaign: { ...rows[0], contact_ids: ids } });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })
);

router.delete('/:id',
  param('id').isUUID(),
  validate,
  asyncHandler(async (req, res) => {
    await db.query('DELETE FROM campaigns WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.status(204).send();
  })
);

router.post('/:id/send',
  param('id').isUUID(),
  body('delayMs').optional().isInt({ min: 0 }),
  validate,
  asyncHandler(async (req, res) => {
    const claim = await db.query(
      `UPDATE campaigns SET status='Sending'
       WHERE id=$1 AND user_id=$2 AND lower(status) NOT IN ('sending','completed','completed with errors')
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!claim.rowCount) throw new HttpError(409, 'Campaign is already sending or has already completed');
    const campaignResult = await db.query(
      `SELECT c.*, t.subject, t.body
       FROM campaigns c
       JOIN templates t ON t.id = c.template_id AND t.user_id=c.user_id
       WHERE c.id=$1 AND c.user_id=$2`,
      [req.params.id, req.user.id]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) {
      await db.query(`UPDATE campaigns SET status='Failed' WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
      throw new HttpError(404, 'Campaign or template not found');
    }
    const contactsResult = await db.query(
      `SELECT contacts.*, stores.url AS store_name, stores.mobile_performance AS mobile_score
       FROM campaign_contacts
       JOIN contacts ON contacts.id = campaign_contacts.contact_id
       LEFT JOIN stores ON stores.id = contacts.store_id
       WHERE campaign_contacts.campaign_id=$1 AND contacts.user_id=$2`,
      [req.params.id, req.user.id]
    );
    if (!contactsResult.rows.length) {
      await db.query(`UPDATE campaigns SET status='Failed' WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
      throw new HttpError(400, 'Campaign has no contacts. Add contacts before sending.');
    }
    const accounts = await getGmailAccounts(req.user.id);
    const results = await sendBulk({
      userId: req.user.id,
      accounts,
      contacts: contactsResult.rows,
      subject: campaign.subject,
      body: campaign.body,
      delayMs: req.body.delayMs || 1000,
      campaignId: campaign.id
    });
    const failed = results.filter(item => item.status !== 'sent').length;
    await db.query('UPDATE campaigns SET status=$1 WHERE id=$2 AND user_id=$3', [
      failed ? (failed === results.length ? 'Failed' : 'Completed with errors') : 'Completed', campaign.id, req.user.id
    ]);
    res.json({ results });
  })
);

module.exports = router;
