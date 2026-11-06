const db = require('../db');
const { sendBulk } = require('./email.service');
const { getGmailAccounts } = require('./settings.service');

const runScheduledCampaigns = async () => {
  // Claim each due campaign in a short transaction. SKIP LOCKED keeps multiple
  // Render instances from sending the same campaign at the same time.
  for (;;) {
    const client = await db.pool.connect();
    let campaign;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id FROM campaigns
         WHERE lower(status)='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
         ORDER BY scheduled_at
         LIMIT 1 FOR UPDATE SKIP LOCKED`
      );
      if (!found.rows[0]) {
        await client.query('COMMIT');
        break;
      }
      const claimed = await client.query(
        `UPDATE campaigns SET status='Sending' WHERE id=$1 RETURNING id, user_id`,
        [found.rows[0].id]
      );
      campaign = claimed.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    try {
      const result = await db.query(
        `SELECT c.id, t.subject, t.body
         FROM campaigns c JOIN templates t ON t.id=c.template_id AND t.user_id=c.user_id
         WHERE c.id=$1 AND c.user_id=$2`,
        [campaign.id, campaign.user_id]
      );
      const template = result.rows[0];
      if (!template) throw new Error('Campaign template is missing');
      const { rows: contacts } = await db.query(
        `SELECT contacts.*, stores.url AS store_name, stores.mobile_performance AS mobile_score
         FROM campaign_contacts
         JOIN contacts ON contacts.id=campaign_contacts.contact_id AND contacts.user_id=$2
         LEFT JOIN stores ON stores.id=contacts.store_id
         WHERE campaign_contacts.campaign_id=$1 AND contacts.email IS NOT NULL AND contacts.email <> ''`,
        [campaign.id, campaign.user_id]
      );
      if (!contacts.length) throw new Error('Campaign has no contacts with email addresses');
      const accounts = await getGmailAccounts(campaign.user_id);
      const results = await sendBulk({
        userId: campaign.user_id,
        accounts,
        contacts,
        subject: template.subject,
        body: template.body,
        delayMs: 1000,
        campaignId: campaign.id
      });
      const failed = results.filter(item => item.status !== 'sent').length;
      await db.query(
        `UPDATE campaigns SET status=$1 WHERE id=$2 AND user_id=$3 AND status='Sending'`,
        [failed ? (failed === results.length ? 'Failed' : 'Completed with errors') : 'Completed', campaign.id, campaign.user_id]
      );
    } catch (error) {
      console.error(`[CampaignRunner] Campaign ${campaign.id} failed:`, error.message);
      await db.query(
        `UPDATE campaigns SET status='Failed' WHERE id=$1 AND user_id=$2 AND status='Sending'`,
        [campaign.id, campaign.user_id]
      );
    }
  }
};

module.exports = { runScheduledCampaigns };
