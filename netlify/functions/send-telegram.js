const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const { saveAnalyticsEvent } = require('../lib/analytics');
const { sendTelegramMessage } = require('../lib/telegram');
const { connectBlobs } = require('../lib/blobs-context');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  connectBlobs(event);

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error('[Configuration Error] Telegram environment variables are missing');
    return jsonResponse(500, {
      ok: false,
      error: 'Telegram belum dikonfigurasi di server'
    });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    let message = String(body.message || '').trim();

    if (!message) {
      return jsonResponse(400, {
        ok: false,
        error: 'Message kosong'
      });
    }

    if (message.length > 3500) {
      message = message.substring(0, 3500) + '\n\n[Pesan dipotong]';
    }

    const [analyticsResult, telegramResult] = await Promise.allSettled([
      body.analytics
        ? saveAnalyticsEvent(body.analytics)
        : Promise.resolve(null),
      sendTelegramMessage(chatId, message)
    ]);

    if (analyticsResult.status === 'rejected') {
      console.error('[Analytics Error]', analyticsResult.reason);
    }

    if (telegramResult.status === 'rejected') {
      console.error('[Telegram API Error]', telegramResult.reason);
      return jsonResponse(502, {
        ok: false,
        error: 'Telegram API error'
      });
    }

    return jsonResponse(200, {
      ok: true,
      analytics_saved: analyticsResult.status === 'fulfilled'
    });
  } catch (error) {
    console.error('[Function Error]', error);
    return jsonResponse(500, {
      ok: false,
      error: 'Server error'
    });
  }
};
