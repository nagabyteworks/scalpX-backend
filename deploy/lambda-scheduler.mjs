/**
 * AWS Lambda EventBridge Scheduler Script (Node.js 24)
 *
 * Schedules EC2 t4g.micro:
 * - 08:45 AM IST: Starts instance (skips weekends and NSE holidays).
 * - 16:00 PM IST: Checks /health. If openPositionsCount > 0, aborts shutdown & sends emergency alert; otherwise stops instance.
 */

import { EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({ region: process.env.AWS_REGION || 'ap-south-1' });

const INSTANCE_ID = process.env.EC2_INSTANCE_ID || '';
const ENGINE_HEALTH_URL = process.env.ENGINE_HEALTH_URL || 'http://127.0.0.1:3000/health';
const NTFY_TOPIC_URL = process.env.NTFY_TOPIC_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Known NSE Trading Holidays (YYYY-MM-DD)
const NSE_HOLIDAYS_2026 = new Set([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-20', // Id-Ul-Fitr
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-09', // Diwali
  '2026-11-10', // Diwali Balipratipada
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
]);

function getISTDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 3600000);
}

function isTradingDay() {
  const ist = getISTDate();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false; // Weekend

  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth() + 1).padStart(2, '0');
  const dd = String(ist.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  return !NSE_HOLIDAYS_2026.has(dateStr);
}

async function sendAlert(message, priority = 'high') {
  console.warn(`[ALERT] ${message}`);

  // ntfy.sh alert
  if (NTFY_TOPIC_URL) {
    try {
      await fetch(NTFY_TOPIC_URL, {
        method: 'POST',
        headers: { Priority: priority, Title: 'scalpX EC2 Alert' },
        body: message,
      });
    } catch (e) {
      console.error('Failed to send ntfy alert:', e);
    }
  }

  // Telegram alert
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `🚨 ${message}` }),
      });
    } catch (e) {
      console.error('Failed to send Telegram alert:', e);
    }
  }
}

export const handler = async (event) => {
  const action = event.action || 'START';
  console.log(`Scheduler triggered with action: ${action}`);

  if (!isTradingDay()) {
    console.log('Non-trading day (weekend or NSE holiday). Skipping EC2 schedule.');
    return { status: 'SKIPPED_HOLIDAY' };
  }

  if (action === 'START') {
    console.log(`Starting EC2 instance ${INSTANCE_ID}...`);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    return { status: 'STARTED', instanceId: INSTANCE_ID };
  }

  if (action === 'STOP') {
    console.log('Performing pre-shutdown safety health check...');
    try {
      const res = await fetch(ENGINE_HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();

      if (data.openPositionsCount > 0) {
        const warning = `ABORTING EC2 SHUTDOWN! Engine currently has ${data.openPositionsCount} OPEN OPTION POSITIONS. Manual intervention required!`;
        await sendAlert(warning, 'urgent');
        return { status: 'ABORTED_OPEN_POSITIONS', openPositionsCount: data.openPositionsCount };
      }
    } catch (err) {
      console.warn('Health check unreachable:', err.message);
    }

    console.log(`Stopping EC2 instance ${INSTANCE_ID}...`);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
    return { status: 'STOPPED', instanceId: INSTANCE_ID };
  }

  return { status: 'UNKNOWN_ACTION' };
};
