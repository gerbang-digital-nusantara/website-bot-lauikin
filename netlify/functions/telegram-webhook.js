const {
  getAnalyticsDiagnostics,
  getDateRange,
  getPeriodRange,
  getSummaryForRange
} = require('../lib/analytics');
const {
  getChatRekapDiagnostics,
  getChatRekapForRange
} = require('../lib/chat-rekap');
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectPeriod(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('bulan') || value.includes('/bulanini')) return 'month';
  if (value.includes('minggu') || value.includes('/mingguini')) return 'week';
  if (value.includes('hari ini') || value.includes('/hariini')) return 'day';
  if (value.trim() === '/rekap' || value.trim() === 'rekap') return 'day';
  return null;
}

function isDiagnosticRequest(text) {
  const value = String(text || '').toLowerCase().trim();
  return value.startsWith('/cekdata') || value.startsWith('/statusdata');
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

  for (const match of value.matchAll(/(^|[^\d./-])(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?![\d./-])/g)) {
    addDateMention(
      matches,
      seen,
      toDayKeyString(Number(match[4]), Number(match[3]), Number(match[2])),
      (match.index || 0) + match[1].length
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

  for (const match of value.matchAll(/(^|[^\d./-])(\d{1,2})[/.](\d{1,2})(?![/.]\d)/g)) {
    addDateMention(
      matches,
      seen,
      toDayKeyString(defaultYear, Number(match[3]), Number(match[2])),
      (match.index || 0) + match[1].length
    );
  }

  if (!matches.length) {
    const compactRequest = value
      .replace(/^\s*\/?rekap\b/, '')
      .replace(/^\s*(tolong|minta|coba)\s+rekap\b/, '')
      .replace(/\b(tgl|tanggal)\b/g, '')
      .trim();
    const dayOnly = /^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/.exec(compactRequest);

    if (dayOnly) {
      const nowParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit'
      }).formatToParts(now);
      const month = Number(nowParts.find((part) => part.type === 'month')?.value);
      const year = Number(nowParts.find((part) => part.type === 'year')?.value);

      addDateMention(
        matches,
        seen,
        toDayKeyString(year, month, Number(dayOnly[1])),
        0
      );

      if (dayOnly[2]) {
        addDateMention(
          matches,
          seen,
          toDayKeyString(year, month, Number(dayOnly[2])),
          1
        );
      }
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

  const period = detectPeriod(text);
  if (period) {
    return { kind: 'period', period };
  }

  return null;
}

function parseDiagnosticsRange(text) {
  const dates = extractDateMentions(text);
  if (dates.length) {
    const startDayKey = dates[0].dayKey;
    const endDayKey = dates[1]?.dayKey || startDayKey;
    return makeCustomRange(startDayKey, endDayKey);
  }

  return getPeriodRange(detectPeriod(text) || 'day');
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

function sumTotals(summary) {
  return Object.values(summary?.totals || {})
    .reduce((total, value) => total + Number(value || 0), 0);
}

function clonePlain(value, fallback) {
  return JSON.parse(JSON.stringify(value || fallback));
}

function chooseTypeBucket(chatSummary, analyticsSummary, type) {
  const chatTotal = Number(chatSummary?.totals?.[type] || 0);
  const analyticsTotal = Number(analyticsSummary?.totals?.[type] || 0);

  if (analyticsTotal > chatTotal) {
    return {
      total: analyticsTotal,
      sourceCounts: clonePlain(analyticsSummary?.sources?.[type], {}),
      labelCounts: clonePlain(analyticsSummary?.labels?.[type], {})
    };
  }

  return {
    total: chatTotal,
    sourceCounts: clonePlain(chatSummary?.sources?.[type], {}),
    labelCounts: clonePlain(chatSummary?.labels?.[type], {})
  };
}

function buildReliableSummary(chatSummary, analyticsSummary) {
  const summary = {
    totals: {},
    sources: {
      visitor: {},
      order_intent: {},
      menu_click: {},
      social_click: {}
    },
    labels: {
      order_intent: {},
      menu_click: {},
      social_click: {}
    },
    uniqueVisitorIds: {}
  };
  const eventTypes = ['visitor', 'order_intent', 'menu_click', 'social_click'];

  for (const type of eventTypes) {
    const bucket = chooseTypeBucket(chatSummary, analyticsSummary, type);
    summary.totals[type] = bucket.total;
    summary.sources[type] = bucket.sourceCounts;
    if (summary.labels[type]) {
      summary.labels[type] = bucket.labelCounts;
    }
  }

  const chatUnique = chatSummary?.uniqueVisitorIds || {};
  const analyticsUnique = analyticsSummary?.uniqueVisitorIds || {};
  summary.uniqueVisitorIds = Object.keys(analyticsUnique).length > Object.keys(chatUnique).length
    ? clonePlain(analyticsUnique, {})
    : clonePlain(chatUnique, {});

  return summary;
}

function getReportSource(chatResult, analyticsResult, finalSummary) {
  const chatTotal = sumTotals(chatResult.summary);
  const analyticsTotal = sumTotals(analyticsResult.summary);
  const finalTotal = sumTotals(finalSummary);

  if (finalTotal === 0) return 'empty';
  if (analyticsTotal > chatTotal) return 'hybrid_analytics_summaries';
  if (chatResult.source === 'chat_events') return 'chat_events';
  return 'chat_summaries';
}

function buildSourceNote(source) {
  if (source === 'hybrid_analytics_summaries') {
    return '<i>Data memakai ringkasan chat + fallback analytics harian, jadi tetap cepat dan tidak kosong kalau chat-summary belum lengkap.</i>';
  }
  if (source === 'chat_events') {
    return '<i>Data dihitung dari pesan chat Telegram tersimpan untuk tanggal ini.</i>';
  }
  if (source === 'chat_summaries') {
    return '<i>Data dihitung dari ringkasan chat harian agar rekap cepat.</i>';
  }
  if (source === 'events') {
    return '<i>Data dibaca dari event mentah karena summary harian belum lengkap.</i>';
  }
  return '<i>Belum ada data tersimpan untuk periode ini.</i>';
}

function buildReport(summary, range, source = 'summaries') {
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
    buildSourceNote(source)
  ].join('\n');
}

async function getReliableRekapForRange(range) {
  const [chatResult, analyticsResult] = await Promise.all([
    getChatRekapForRange(range, { fallbackToMessages: false }),
    getSummaryForRange(range, { fallbackToEvents: false })
  ]);
  let summary = buildReliableSummary(chatResult.summary, analyticsResult.summary);
  let source = getReportSource(chatResult, analyticsResult, summary);

  if (sumTotals(summary) > 0) {
    return { summary, range, source };
  }

  const [chatFallback, analyticsFallback] = await Promise.all([
    getChatRekapForRange(range, { fallbackToMessages: true }),
    getSummaryForRange(range, { fallbackToEvents: true })
  ]);
  summary = buildReliableSummary(chatFallback.summary, analyticsFallback.summary);
  source = getReportSource(chatFallback, analyticsFallback, summary);

  return { summary, range, source };
}

async function sendReport(chatId, request) {
  let done = false;
  callTelegram('sendChatAction', {
    chat_id: chatId,
    action: 'typing'
  }).catch(() => {});

  wait(1200)
    .then(async () => {
      if (done) return;
      await sendTelegramMessage(
        chatId,
        'Sebentar, rekap sedang dibaca dari data chat Telegram...'
      );
    })
    .catch(() => {});

  const targetRange = request.kind === 'range'
    ? request.range
    : getPeriodRange(request.period);
  const { summary, range, source } = await getReliableRekapForRange(targetRange);
  done = true;

  return sendTelegramMessage(chatId, buildReport(summary, range, source), {
    reply_markup: PERIOD_BUTTONS
  });
}

function buildDiagnosticsReport(chatResult, analyticsResult) {
  const chatSummaryTotals = chatResult.summary.totals || {};
  const chatEventTotals = chatResult.eventSummary.totals || {};
  const analyticsSummaryTotals = analyticsResult.summary.totals || {};
  const analyticsEventTotals = analyticsResult.eventSummary.totals || {};
  const verdict = chatResult.eventTotal > 0 || chatResult.summaryTotal > 0
    ? 'Data rekap chat ada.'
    : 'Belum ada data rekap chat untuk range ini.';

  return [
    '<b>CEK DATA REKAP</b>',
    `${formatWib(chatResult.range.start)} - ${formatWib(chatResult.range.end)} WIB`,
    '',
    `<b>${verdict}</b>`,
    '',
    '<b>Rekap chat Telegram:</b>',
    `  - Summary chat: <b>${chatResult.summaryTotal}</b> event`,
    `    • Pengunjung: <b>${chatSummaryTotals.visitor || 0}</b>`,
    `    • Klik pesan: <b>${chatSummaryTotals.order_intent || 0}</b>`,
    `  - Pesan chat tersimpan: <b>${chatResult.rawMessageCount}</b> pesan / <b>${chatResult.eventTotal}</b> event valid`,
    `    • Pengunjung: <b>${chatEventTotals.visitor || 0}</b>`,
    `    • Klik pesan: <b>${chatEventTotals.order_intent || 0}</b>`,
    '',
    '<b>Analytics lama:</b>',
    `  - Summary analytics: <b>${analyticsResult.summaryTotal}</b> event`,
    `    • Pengunjung: <b>${analyticsSummaryTotals.visitor || 0}</b>`,
    `    • Klik pesan: <b>${analyticsSummaryTotals.order_intent || 0}</b>`,
    `  - Event analytics mentah: <b>${analyticsResult.rawEventCount}</b> blob / <b>${analyticsResult.eventTotal}</b> event valid`,
    `    • Pengunjung: <b>${analyticsEventTotals.visitor || 0}</b>`,
    `    • Klik pesan: <b>${analyticsEventTotals.order_intent || 0}</b>`,
    '',
    chatResult.eventTotal > chatResult.summaryTotal
      ? '<i>Pesan chat mentah lebih lengkap dari summary. Rekap akan fallback ke pesan chat tersimpan.</i>'
      : '<i>Rekap utama sekarang memakai data chat Telegram, bukan scan semua analytics.</i>'
  ].join('\n');
}

async function sendDiagnostics(chatId, text) {
  const range = parseDiagnosticsRange(text);
  const [chatResult, analyticsResult] = await Promise.all([
    getChatRekapDiagnostics(range),
    getAnalyticsDiagnostics(range)
  ]);

  return sendTelegramMessage(chatId, buildDiagnosticsReport(chatResult, analyticsResult), {
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
    if (isDiagnosticRequest(text)) {
      await sendDiagnostics(chatId, text);
      return jsonResponse(200, { ok: true });
    }

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
          '/rekap 2026-06-01 2026-06-09',
          '/rekap 9',
          '/rekap 9/6'
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
          '/rekap 9 - rekap tanggal 9 bulan ini',
          '/rekap 9/6 - rekap 9 Juni tahun ini',
          '/cekdata 2026-06-09 - cek data rekap chat tersimpan atau tidak',
          '',
          'Bisa juga tulis: <i>tolong rekap minggu ini</i>, <i>tolong rekap 8 juni 2026</i>, atau <i>rekap tanggal 9</i>.'
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
