const {
  getEventsForPeriod
} = require('../lib/analytics');
const {
  callTelegram,
  escapeHtml,
  sendTelegramMessage
} = require('../lib/telegram');

const PERIOD_BUTTONS = {
  inline_keyboard: [[
    { text: 'Hari ini', callback_data: 'report:day' },
    { text: 'Minggu ini', callback_data: 'report:week' },
    { text: 'Bulan ini', callback_data: 'report:month' }
  ]]
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function detectPeriod(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('bulan') || value.includes('/bulanini')) return 'month';
  if (value.includes('minggu') || value.includes('/mingguini')) return 'week';
  if (value.includes('hari ini') || value.includes('/hariini')) return 'day';
  return null;
}

function countBySource(events) {
  const counts = new Map();
  for (const event of events) {
    const source = event.source || 'Unknown';
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function sourceLines(events) {
  const counts = countBySource(events);
  if (!counts.length) return '  Belum ada data';
  return counts
    .map(([source, total]) => `  - ${escapeHtml(source)}: <b>${total}</b>`)
    .join('\n');
}

function formatWib(date) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function buildReport(events, range) {
  const visitors = events.filter((event) => event.type === 'visitor');
  const orders = events.filter((event) => event.type === 'order_intent');
  const menuClicks = events.filter((event) => event.type === 'menu_click');
  const socialClicks = events.filter((event) => event.type === 'social_click');
  const uniqueVisitors = new Set(
    visitors.map((event) => event.visitorId || event.id)
  ).size;
  const conversion = visitors.length
    ? `${((orders.length / visitors.length) * 100).toFixed(1)}%`
    : '0%';

  return [
    `<b>REKAP ${range.label.toUpperCase()}</b>`,
    `${formatWib(range.start)} - ${formatWib(range.end)} WIB`,
    '',
    `<b>Pengunjung unik: ${uniqueVisitors}</b>`,
    `<b>Total sesi kunjungan: ${visitors.length}</b>`,
    '<b>Asal pengunjung:</b>',
    sourceLines(visitors),
    '',
    `<b>Klik "Mau Pesan": ${orders.length}</b>`,
    `<b>Konversi kunjungan ke klik: ${conversion}</b>`,
    '<b>Asal klik pesan:</b>',
    sourceLines(orders),
    '',
    `<b>Klik menu produk: ${menuClicks.length}</b>`,
    `<b>Klik tautan sosial: ${socialClicks.length}</b>`,
    '',
    '<i>Data dihitung sejak fitur rekap mulai dideploy.</i>'
  ].join('\n');
}

async function sendReport(chatId, period) {
  const { events, range } = await getEventsForPeriod(period);
  return sendTelegramMessage(chatId, buildReport(events, range), {
    reply_markup: PERIOD_BUTTONS
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret =
    event.headers?.['x-telegram-bot-api-secret-token'];

  if (!webhookSecret || receivedSecret !== webhookSecret) {
    return jsonResponse(401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const update = JSON.parse(event.body || '{}');
    const callback = update.callback_query;
    const message = update.message;
    const chatId = String(
      callback?.message?.chat?.id || message?.chat?.id || ''
    );
    const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || '');

    if (!chatId || chatId !== allowedChatId) {
      return jsonResponse(200, { ok: true, ignored: true });
    }

    if (callback) {
      await callTelegram('answerCallbackQuery', {
        callback_query_id: callback.id
      });

      const period = String(callback.data || '').replace('report:', '');
      if (['day', 'week', 'month'].includes(period)) {
        await sendReport(chatId, period);
      }
      return jsonResponse(200, { ok: true });
    }

    const text = String(message?.text || '');
    const period = detectPeriod(text);

    if (period) {
      await sendReport(chatId, period);
    } else {
      await sendTelegramMessage(
        chatId,
        [
          '<b>Rekap Lauk.In</b>',
          '',
          'Kirim salah satu perintah:',
          '/hariini - rekap hari ini',
          '/mingguini - rekap minggu ini',
          '/bulanini - rekap bulan ini',
          '',
          'Bisa juga tulis: <i>tolong rekap minggu ini</i>.'
        ].join('\n'),
        { reply_markup: PERIOD_BUTTONS }
      );
    }

    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error('[Telegram Webhook Error]', error);
    return jsonResponse(500, {
      ok: false,
      error: 'Webhook error'
    });
  }
};
