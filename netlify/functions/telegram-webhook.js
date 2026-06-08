const {
  getDateRange,
  getSummaryForRange,
  getSummaryForPeriod
} = require('../lib/analytics');
const {
  callTelegram,
  escapeHtml,
  sendTelegramMessage
} = require('../lib/telegram');
const { connectBlobs } = require('../lib/blobs-context');

const PERIOD_BUTTONS = {
  inline_keyboard: [[
    { text: 'Hari ini', callback_data: 'report:day' },
    { text: 'Minggu ini', callback_data: 'report:week' },
    { text: 'Bulan ini', callback_data: 'report:month' }
  ]]
};
const MAX_CUSTOM_RANGE_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = {
  jan: 1,
  januari: 1,
  feb: 2,
  februari: 2,
  mar: 3,
  maret: 3,
  apr: 4,
  april: 4,
  mei: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  agu: 8,
  agustus: 8,
  sep: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  des: 12,
  desember: 12
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
  if (value.trim() === '/rekap' || value.trim() === 'rekap') return 'day';
  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDayKeyString(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function currentWibYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric'
  }).format(now));
}

function addDateMention(matches, seen, dayKey, index) {
  try {
    getDateRange(dayKey);
    const token = `${index}:${dayKey}`;
    if (!seen.has(token)) {
      seen.add(token);
      matches.push({ dayKey, index });
    }
  } catch {
    // Abaikan tanggal yang tidak valid, misalnya 31/02/2026.
  }
}

function extractDateMentions(text, now = new Date()) {
  const value = String(text || '').toLowerCase();
  const defaultYear = currentWibYear(now);
  const matches = [];
  const seen = new Set();

  for (const match of value.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    addDateMention(
      matches,
      seen,
      toDayKeyString(Number(match[1]), Number(match[2]), Number(match[3])),
      match.index || 0
    );
  }

  for (const match of value.matchAll(/\b(?!20\d{2}[-/.])(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/g)) {
    addDateMention(
      matches,
      seen,
      toDayKeyString(Number(match[3]), Number(match[2]), Number(match[1])),
      match.index || 0
    );
  }

  const monthPattern = Object.keys(MONTHS).join('|');
  const monthRegex = new RegExp(
    `\\b(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\b`,
    'g'
  );

  for (const match of value.matchAll(monthRegex)) {
    const month = MONTHS[match[3]];
    const year = Number(match[4] || defaultYear);
    const firstDay = Number(match[1]);
    const secondDay = Number(match[2] || 0);
    const index = match.index || 0;

    addDateMention(
      matches,
      seen,
      toDayKeyString(year, month, firstDay),
      index
    );

    if (secondDay) {
      addDateMention(
        matches,
        seen,
        toDayKeyString(year, month, secondDay),
        index + 1
      );
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

function formatWibDate(date) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function makeCustomRange(startDayKey, endDayKey) {
  const initial = getDateRange(startDayKey, endDayKey);
  const dayCount = Math.floor((initial.end - initial.start) / DAY_MS) + 1;

  if (dayCount > MAX_CUSTOM_RANGE_DAYS) {
    throw new Error(`Range maksimal ${MAX_CUSTOM_RANGE_DAYS} hari.`);
  }

  const label = initial.startDayKey === initial.endDayKey
    ? formatWibDate(initial.start)
    : `${formatWibDate(initial.start)} - ${formatWibDate(initial.end)}`;

  return getDateRange(initial.startDayKey, initial.endDayKey, label);
}

function parseReportRequest(text) {
  const period = detectPeriod(text);
  if (period) {
    return { kind: 'period', period };
  }

  const dates = extractDateMentions(text);
  if (dates.length) {
    try {
      const startDayKey = dates[0].dayKey;
      const endDayKey = dates[1]?.dayKey || startDayKey;
      return {
        kind: 'range',
        range: makeCustomRange(startDayKey, endDayKey)
      };
    } catch (error) {
      return {
        kind: 'error',
        message: error.message || 'Format tanggal tidak valid.'
      };
    }
  }

  return null;
}

function sourceLines(sourceCounts) {
  const counts = Object.entries(sourceCounts || {})
    .sort((a, b) => b[1] - a[1]);

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

function buildReport(summary, range) {
  const totals = summary.totals || {};
  const visitors = totals.visitor || 0;
  const orders = totals.order_intent || 0;
  const menuClicks = totals.menu_click || 0;
  const socialClicks = totals.social_click || 0;
  const uniqueVisitors = Object.keys(summary.uniqueVisitorIds || {}).length;
  const conversion = visitors
    ? `${((orders / visitors) * 100).toFixed(1)}%`
    : '0%';

  return [
    `<b>REKAP ${range.label.toUpperCase()}</b>`,
    `${formatWib(range.start)} - ${formatWib(range.end)} WIB`,
    '',
    `<b>Pengunjung unik: ${uniqueVisitors}</b>`,
    `<b>Total sesi kunjungan: ${visitors}</b>`,
    '<b>Asal pengunjung:</b>',
    sourceLines(summary.sources?.visitor),
    '',
    `<b>Klik "Mau Pesan": ${orders}</b>`,
    `<b>Konversi kunjungan ke klik: ${conversion}</b>`,
    '<b>Asal klik pesan:</b>',
    sourceLines(summary.sources?.order_intent),
    '',
    `<b>Klik menu produk: ${menuClicks}</b>`,
    `<b>Klik tautan sosial: ${socialClicks}</b>`,
    '',
    '<i>Data dihitung dari ringkasan harian agar rekap cepat.</i>'
  ].join('\n');
}

async function sendReport(chatId, request) {
  const { summary, range } = request.kind === 'range'
    ? await getSummaryForRange(request.range)
    : await getSummaryForPeriod(request.period);

  return sendTelegramMessage(chatId, buildReport(summary, range), {
    reply_markup: PERIOD_BUTTONS
  });
}

exports.handler = async (event) => {
  connectBlobs(event);

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
        await sendReport(chatId, { kind: 'period', period });
      }
      return jsonResponse(200, { ok: true });
    }

    const text = String(message?.text || '');
    const request = parseReportRequest(text);

    if (request?.kind === 'error') {
      await sendTelegramMessage(
        chatId,
        [
          '<b>Format tanggal belum tepat</b>',
          escapeHtml(request.message),
          '',
          'Contoh:',
          '/rekap 2026-06-09',
          '/rekap 09/06/2026',
          '/rekap 2026-06-01 2026-06-09'
        ].join('\n'),
        { reply_markup: PERIOD_BUTTONS }
      );
    } else if (request) {
      await sendReport(chatId, request);
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
          '/rekap 2026-06-09 - rekap tanggal tertentu',
          '/rekap 2026-06-01 2026-06-09 - rekap range tanggal',
          '',
          'Bisa juga tulis: <i>tolong rekap minggu ini</i> atau <i>tolong rekap 8 juni 2026</i>.'
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
