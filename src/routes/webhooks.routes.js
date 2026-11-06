const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const verifySendGrid = (req) => {
  const publicKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  const signature = req.get('X-Twilio-Email-Event-Webhook-Signature');
  const timestamp = req.get('X-Twilio-Email-Event-Webhook-Timestamp');
  if (!publicKey || !signature || !timestamp || !req.rawBody) return false;
  try {
    return crypto.verify('sha256', Buffer.concat([Buffer.from(timestamp), req.rawBody]), publicKey, Buffer.from(signature, 'base64'));
  } catch { return false; }
};

const verifyMailgun = (req) => {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  const signature = req.body?.signature;
  if (!key || !signature?.timestamp || !signature?.token || !signature?.signature) return false;
  const expected = crypto.createHmac('sha256', key).update(`${signature.timestamp}${signature.token}`).digest('hex');
  return safeEqual(expected, signature.signature);
};

const normalizedMessageId = value => String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();

const applyProviderEvent = async ({ provider, eventId, messageId, kind, occurredAt, detail }) => {
  const normalizedId = normalizedMessageId(messageId);
  if (!normalizedId) return false;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const log = await client.query(
      `SELECT id FROM email_logs
       WHERE lower(replace(replace(provider_message_id, '<', ''), '>', ''))=$1
       FOR UPDATE`,
      [normalizedId]
    );
    if (!log.rows[0]) { await client.query('ROLLBACK'); return false; }

    if (eventId) {
      const saved = await client.query(
        `INSERT INTO email_provider_events (provider, event_id, email_log_id, event_type, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (provider,event_id) DO NOTHING RETURNING event_id`,
        [provider, eventId, log.rows[0].id, kind, occurredAt || new Date(), JSON.stringify(detail)]
      );
      if (!saved.rowCount) { await client.query('COMMIT'); return true; }
    }

    const id = log.rows[0].id;
    if (kind === 'open') await client.query(`UPDATE email_logs SET opened='Yes', opened_at=COALESCE(opened_at,$2) WHERE id=$1`, [id, occurredAt || new Date()]);
    else if (kind === 'click') await client.query(`UPDATE email_logs SET clicked='Yes' WHERE id=$1`, [id]);
    else if (kind === 'reply') await client.query(`UPDATE email_logs SET replied='Yes', replied_at=COALESCE(replied_at,$2) WHERE id=$1`, [id, occurredAt || new Date()]);
    else if (kind === 'bounce' || kind === 'dropped') await client.query(`UPDATE email_logs SET status=$2 WHERE id=$1`, [id, kind]);
    else if (kind === 'delivered') await client.query(`UPDATE email_logs SET status='delivered' WHERE id=$1 AND lower(status)='sent'`, [id]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

router.post('/sendgrid', asyncHandler(async (req, res) => {
  if (!verifySendGrid(req)) return res.status(401).json({ error: 'Invalid SendGrid webhook signature' });
  for (const event of (Array.isArray(req.body) ? req.body : [])) {
    const eventType = String(event.event || '').toLowerCase();
    const kind = eventType === 'open' ? 'open' : eventType === 'click' ? 'click' :
      ['bounce', 'blocked'].includes(eventType) ? 'bounce' : eventType === 'dropped' ? 'dropped' :
      ['delivered', 'processed'].includes(eventType) ? 'delivered' : null;
    if (!kind) continue;
    const matched = await applyProviderEvent({
      provider: 'sendgrid', eventId: event.sg_event_id || event['sg_event_id'],
      messageId: event['smtp-id'] || event['smtp_id'], kind,
      occurredAt: event.timestamp ? new Date(Number(event.timestamp) * 1000) : null, detail: event
    });
    if (!matched) return res.status(503).json({ error: 'Email log is not available yet; retry webhook' });
  }
  res.sendStatus(204);
}));

router.post('/mailgun', asyncHandler(async (req, res) => {
  if (!verifyMailgun(req)) return res.status(401).json({ error: 'Invalid Mailgun webhook signature' });
  const event = req.body?.['event-data'] || {};
  const type = String(event.event || '').toLowerCase();
  const kind = type === 'opened' ? 'open' : type === 'clicked' ? 'click' :
    type === 'failed' ? 'bounce' : ['delivered', 'accepted'].includes(type) ? 'delivered' : null;
  if (kind) {
    const headers = event.message?.headers || {};
    const messageId = headers['message-id'] || headers['Message-Id'] || event.message?.['message-id'];
    const matched = await applyProviderEvent({
      provider: 'mailgun', eventId: event.id, messageId, kind,
      occurredAt: event.timestamp ? new Date(Number(event.timestamp) * 1000) : null, detail: event
    });
    if (!matched) return res.status(503).json({ error: 'Email log is not available yet; retry webhook' });
  }
  res.sendStatus(204);
}));

module.exports = router;
