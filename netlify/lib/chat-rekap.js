const crypto = require('node:crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'laukin-analytics';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const EVENT_TYPES = new Set([
  'visitor',
  'order_intent',
  'menu_click',
  'social_click'
]);
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

function getChatRekapStore() {
  return getStore(STORE_NAME);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value, fallback = '', maxLength = 500) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

function cleanKeyPart(value, fallback, maxLength = 160) {
  return cleanText(value, fallback, maxLength)
    .replace(/[^a-zA-Z0-9._:-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || fallback;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

function normalizeLineKey(key) {
  return String(key || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractTextField(plainText, label) {
  const wanted = normalizeLineKey(label);

  for (const rawLine of String(plainText || '').split('\n')) {
    const line = rawLine.trim();
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = normalizeLineKey(line.slice(0, colonIndex));
    if (key === wanted) {
      return line.slice(colonIndex + 1).trim();
    }
  }

  return '';
}

function toWibParts(date) {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}

function toDayKey(date) {
  const { year, month, day } = toWibParts(date);
  return [
    String(year),
    String(month + 1).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}

function wibDateToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - WIB_OFFSET_MS);
}

function parseChatWibTimestamp(text) {
  const plain = stripHtml(text);
  const explicitTime = extractTextField(plain, 'Waktu') || plain;

  const namedMonth = explicitTime.match(
    /\b(\d{1,2})\s+([a-zA-Z]+)\s+(20\d{2})(?:[^\d]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?)?/i
  );
  if (namedMonth) {
    const month = MONTHS[namedMonth[2].toLowerCase()];
    if (month) {
      return wibDateToUtc(
        Number(namedMonth[3]),
        month,
        Number(namedMonth[1]),
        Number(namedMonth[4] || 0),
        Number(namedMonth[5] || 0),
        Number(namedMonth[6] || 0)
      );
    }
  }

  const numeric = explicitTime.match(
    /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})(?:[^\d]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?)?\b/
  );
  if (numeric) {
    return wibDateToUtc(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
      Number(numeric[4] || 0),
      Number(numeric[5] || 0),
      Number(numeric[6] || 0)
    );
  }

  const iso = explicitTime.match(
    /\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:[^\d]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?)?\b/
  );
  if (iso) {
    return wibDateToUtc(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] || 0),
      Number(iso[5] || 0),
      Number(iso[6] || 0)
    );
  }

  return null;
}

function parseMessageType(plainText, analytics) {
  const rawType = String(analytics?.type || '').trim();
  if (EVENT_TYPES.has(rawType)) return rawType;

  if (/pengunjung\s+baru/i.test(plainText)) return 'visitor';
  if (/ada\s+yang\s+mau\s+pesan/i.test(plainText)) return 'order_intent';
  if (/klik\s+menu\s*:/i.test(plainText)) return 'menu_click';
  if (/^klik\s*:/i.test(plainText) || /\nklik\s*:/i.test(plainText)) return 'social_click';

  return null;
}

function parseMessageLabel(plainText, type, analytics) {
  if (analytics?.label) return cleanText(analytics.label, '', 150);
  if (type === 'order_intent') return cleanText(extractTextField(plainText, 'Tombol'), '', 150);
  if (type === 'menu_click') {
    const match = plainText.match(/klik\s+menu\s*:\s*([^\n]+)/i);
    return cleanText(match?.[1], '', 150);
  }
  if (type === 'social_click') {
    const match = plainText.match(/klik\s*:\s*([^\n]+)/i);
    return cleanText(match?.[1], '', 150);
  }
  return '';
}

function makeEmptySummary(dayKey = '') {
  return {
    dayKey,
    totals: {
      visitor: 0,
      order_intent: 0,
      menu_click: 0,
      social_click: 0
    },
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
    eventIds: {},
    uniqueVisitorIds: {}
  };
}

function normalizeSummary(value, dayKey = '') {
  const empty = makeEmptySummary(dayKey);
  const summary = value && typeof value === 'object'
    ? value
    : empty;

  summary.dayKey ||= dayKey;
  summary.totals = {
    ...empty.totals,
    ...(summary.totals || {})
  };
  summary.sources ||= {};
  for (const type of EVENT_TYPES) {
    summary.sources[type] ||= {};
  }
  summary.labels ||= {};
  summary.labels.order_intent ||= {};
  summary.labels.menu_click ||= {};
  summary.labels.social_click ||= {};
  summary.eventIds ||= {};
  summary.uniqueVisitorIds ||= {};

  return summary;
}

function incrementCount(bucket, key) {
  const safeKey = cleanText(key, 'Unknown', 150);
  bucket[safeKey] = (bucket[safeKey] || 0) + 1;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function sumSummaryTotals(summary) {
  return Object.values(summary?.totals || {})
    .reduce((total, value) => total + Number(value || 0), 0);
}

function applyChatEventToSummary(summary, event) {
  if (!event?.id || !EVENT_TYPES.has(event.type)) return false;
  if (summary.eventIds[event.id]) return false;

  summary.eventIds[event.id] = true;
  summary.totals[event.type] = (summary.totals[event.type] || 0) + 1;
  summary.sources[event.type] ||= {};
  incrementCount(summary.sources[event.type], event.source || 'Unknown');

  if (event.type === 'visitor' && event.visitorId) {
    summary.uniqueVisitorIds[event.visitorId] = true;
  }

  if (event.label && summary.labels?.[event.type]) {
    incrementCount(summary.labels[event.type], event.label);
  }

  return true;
}

function summarizeChatEvents(events) {
  const summary = makeEmptySummary();
  for (const event of events || []) {
    applyChatEventToSummary(summary, event);
  }
  return summary;
}

async function updateDailyChatSummary(store, event, dayKey) {
  const key = `chat-summaries/${dayKey}.json`;
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await store.getWithMetadata(key, {
      type: 'json',
      consistency: 'strong'
    });
    const summary = normalizeSummary(existing?.data, dayKey);
    const changed = applyChatEventToSummary(summary, event);

    if (!changed) {
      return { counted: false, duplicate: true };
    }

    const result = await store.setJSON(
      key,
      summary,
      existing?.etag
        ? { onlyIfMatch: existing.etag }
        : { onlyIfNew: true }
    );

    if (result.modified) {
      return { counted: true, duplicate: false };
    }

    await sleep(30 * (attempt + 1));
  }

  throw new Error(`Gagal update rekap chat ${dayKey}`);
}

function buildChatEvent(message, analytics = null, options = {}) {
  const plainText = stripHtml(message);
  const type = parseMessageType(plainText, analytics);
  if (!type) return null;

  const timestamp = parseChatWibTimestamp(message) || new Date();
  const idSeed = [
    analytics?.eventId,
    options.telegramMessageId,
    timestamp.toISOString(),
    plainText
  ].filter(Boolean).join('|');
  const id = cleanKeyPart(
    analytics?.eventId || `chat-${crypto.createHash('sha1').update(idSeed).digest('hex')}`,
    `chat-${crypto.randomUUID()}`
  );

  return {
    id,
    telegramMessageId: options.telegramMessageId || '',
    type,
    visitorId: cleanText(analytics?.visitorId, '', 100),
    source: cleanText(analytics?.source || extractTextField(plainText, 'Platform'), 'Unknown', 100),
    sourceDetail: cleanText(analytics?.sourceDetail, '', 300),
    device: cleanText(analytics?.device || extractTextField(plainText, 'Device'), 'Unknown', 100),
    label: parseMessageLabel(plainText, type, analytics),
    url: cleanText(analytics?.url || extractTextField(plainText, 'URL'), '', 1000),
    timestamp: timestamp.toISOString(),
    dayKey: toDayKey(timestamp),
    plainText: plainText.slice(0, 2000)
  };
}

async function saveChatRekapMessage(message, analytics = null, options = {}) {
  const event = buildChatEvent(message, analytics, options);
  if (!event) {
    return { saved: false, reason: 'not_rekap_message' };
  }

  const store = getChatRekapStore();
  const eventKey = `chat-events/${event.dayKey}/${event.id}.json`;
  const summaryResult = await updateDailyChatSummary(store, event, event.dayKey);

  try {
    await store.setJSON(eventKey, event, { onlyIfNew: true });
  } catch (error) {
    console.error('[Chat Rekap Event Log Error]', error);
  }

  return {
    saved: true,
    ...event,
    counted: summaryResult.counted,
    duplicate: summaryResult.duplicate
  };
}

function getDayKeys(start, end) {
  const keys = [];
  const startParts = toWibParts(start);
  const cursor = new Date(Date.UTC(
    startParts.year,
    startParts.month,
    startParts.day
  ) - WIB_OFFSET_MS);

  while (cursor <= end) {
    keys.push(toDayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
}

async function getChatEventsForRange(range) {
  const store = getChatRekapStore();
  const dayKeys = getDayKeys(range.start, range.end);
  const events = [];

  for (const dayKey of dayKeys) {
    for await (const result of store.list({
      prefix: `chat-events/${dayKey}/`,
      paginate: true
    })) {
      const entries = await Promise.all(
        result.blobs.map((blob) => store.get(blob.key, {
          type: 'json',
          consistency: 'strong'
        }))
      );

      for (const entry of entries) {
        if (!entry?.timestamp) continue;
        const timestamp = new Date(entry.timestamp);
        if (timestamp >= range.start && timestamp <= range.end) {
          events.push(entry);
        }
      }
    }
  }

  return { events, range };
}

async function getChatRekapForRange(range, options = {}) {
  const { fallbackToMessages = true } = options;
  const store = getChatRekapStore();
  const dayKeys = getDayKeys(range.start, range.end);
  const summary = makeEmptySummary();

  const summaries = await Promise.all(
    dayKeys.map((dayKey) => store.get(`chat-summaries/${dayKey}.json`, {
      type: 'json',
      consistency: 'strong'
    }))
  );

  for (const value of summaries) {
    if (!value) continue;
    const daySummary = normalizeSummary(value);

    for (const [type, total] of Object.entries(daySummary.totals || {})) {
      summary.totals[type] = (summary.totals[type] || 0) + Number(total || 0);
    }

    for (const type of EVENT_TYPES) {
      mergeCounts(summary.sources[type], daySummary.sources?.[type]);
    }

    mergeCounts(summary.labels.order_intent, daySummary.labels?.order_intent);
    mergeCounts(summary.labels.menu_click, daySummary.labels?.menu_click);
    mergeCounts(summary.labels.social_click, daySummary.labels?.social_click);

    for (const visitorId of Object.keys(daySummary.uniqueVisitorIds || {})) {
      summary.uniqueVisitorIds[visitorId] = true;
    }
  }

  if (fallbackToMessages && sumSummaryTotals(summary) === 0) {
    const { events } = await getChatEventsForRange(range);
    const eventSummary = summarizeChatEvents(events);

    if (sumSummaryTotals(eventSummary) > 0) {
      return { summary: eventSummary, range, source: 'chat_events' };
    }
  }

  return { summary, range, source: 'chat_summaries' };
}

async function getChatRekapDiagnostics(range) {
  const { summary } = await getChatRekapForRange(range, {
    fallbackToMessages: false
  });
  const { events } = await getChatEventsForRange(range);
  const eventSummary = summarizeChatEvents(events);

  return {
    range,
    summary,
    eventSummary,
    rawMessageCount: events.length,
    summaryTotal: sumSummaryTotals(summary),
    eventTotal: sumSummaryTotals(eventSummary)
  };
}

module.exports = {
  buildChatEvent,
  getChatEventsForRange,
  getChatRekapDiagnostics,
  getChatRekapForRange,
  saveChatRekapMessage,
  stripHtml,
  toDayKey
};
