const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const { saveAnalyticsEvent } = require('../lib/analytics');
const { saveChatRekapMessage } = require('../lib/chat-rekap');
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

    const analyticsPromise = body.analytics
      ? saveAnalyticsEvent(body.analytics)
      : Promise.resolve(null);

    let telegramMessage;
    try {
      telegramMessage = await sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('[Telegram API Error]', error);
      return jsonResponse(502, {
        ok: false,
        error: 'Telegram API error'
      });
    }

    const [analyticsResult, chatRekapResult] = await Promise.allSettled([
      analyticsPromise,
      saveChatRekapMessage(message, body.analytics, {
        telegramMessageId: telegramMessage?.message_id
      })
    ]);

    if (analyticsResult.status === 'rejected') {
      console.error('[Analytics Error]', analyticsResult.reason);
    }

    if (chatRekapResult.status === 'rejected') {
      console.error('[Chat Rekap Error]', chatRekapResult.reason);
    }

    return jsonResponse(200, {
      ok: true,
      analytics_saved: analyticsResult.status === 'fulfilled',
      chat_rekap_saved: chatRekapResult.status === 'fulfilled'
        && Boolean(chatRekapResult.value?.saved),
      chat_rekap_counted: chatRekapResult.status === 'fulfilled'
        && Boolean(chatRekapResult.value?.counted)
    });
  } catch (error) {
    console.error('[Function Error]', error);
    return jsonResponse(500, {
      ok: false,
      error: 'Server error'
    });
  }
};
