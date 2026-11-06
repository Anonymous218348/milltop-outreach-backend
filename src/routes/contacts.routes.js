const express = require('express');
const { body, param } = require('express-validator');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM contacts WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ contacts: rows });
}));

router.post('/',
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
  body('storeId').optional({ nullable: true }).isUUID(),
  validate,
  asyncHandler(async (req, res) => {
    const { name, email, domain, status, outreachStage, notes, storeId } = req.body;
    const { rows } = await db.query(
      `INSERT INTO contacts (user_id, store_id, name, email, domain, status, outreach_stage, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'new'),COALESCE($7,'lead'),$8::jsonb)
       RETURNING *`,
      [req.user.id, storeId || null, name || null, email || null, domain || null, status || null, outreachStage || null, JSON.stringify(Array.isArray(notes) ? notes : notes ? [{ text: String(notes), ts: new Date().toISOString() }] : [])]
    );
    res.status(201).json({ contact: rows[0] });
  })
);

router.put('/:id',
  param('id').isUUID(),
  body('email').optional().isEmail().normalizeEmail(),
  validate,
  asyncHandler(async (req, res) => {
    const current = await db.query('SELECT * FROM contacts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const contact = { ...current.rows[0], ...req.body };
    const { rows } = await db.query(
      `UPDATE contacts SET store_id=$1, name=$2, email=$3, domain=$4, status=$5, outreach_stage=$6, notes=$7::jsonb
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [
        contact.storeId || contact.store_id || null,
        contact.name || null,
        contact.email,
        contact.domain || null,
        contact.status || 'new',
        contact.outreachStage || contact.outreach_stage || 'lead',
        JSON.stringify(Array.isArray(contact.notes) ? contact.notes : contact.notes ? [{ text: String(contact.notes), ts: new Date().toISOString() }] : []),
        req.params.id,
        req.user.id
      ]
    );
    res.json({ contact: rows[0] || null });
  })
);

router.delete('/:id',
  param('id').isUUID(),
  validate,
  asyncHandler(async (req, res) => {
    await db.query('DELETE FROM contacts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.status(204).send();
  })
);

module.exports = router;
