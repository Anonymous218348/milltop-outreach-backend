const cron = require('node-cron');
const db = require('../db');
const { pollReplies } = require('../services/gmail.service.js');
const { runScheduledCampaigns } = require('../services/campaignRunner.service');

const startReplyPoller = () => {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    console.log('[ReplyPoller] Checking for replies...');

    try {
      // Get all users who have Gmail connected
      const { rows } = await db.query(
        'SELECT user_id FROM user_settings WHERE gmail_refresh_token IS NOT NULL'
      );

      for (const row of rows) {
        await pollReplies(row.user_id);
      }

      console.log(`[ReplyPoller] Done — checked ${rows.length} user(s)`);
    } catch (err) {
      console.error('[ReplyPoller] Error:', err.message);
    }
  });

  cron.schedule('* * * * *', async () => {
    try {
      await runScheduledCampaigns();
    } catch (err) {
      console.error('[CampaignRunner] Scheduler error:', err.message);
    }
  });

  console.log('[ReplyPoller] Started — polling every 5 minutes; scheduled campaigns checked every minute');
};

module.exports = { startReplyPoller };
