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

async function getAnalyticsStore() {
  return getStore(STORE_NAME);
}

function cleanText(value, fallback, maxLength = 500) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function wibMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day) - WIB_OFFSET_MS);
}

function parseDayKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = wibMidnightUtc(year, month, day);

  return toDayKey(date) === dayKey
    ? { year, month, day, date }
    : null;
}

function getPeriodRange(period, now = new Date()) {
  const { year, month, day, weekday } = toWibParts(now);
  let start;
  let label;

  if (period === 'week') {
    const daysSinceMonday = (weekday + 6) % 7;
    start = wibMidnightUtc(year, month, day - daysSinceMonday);
    label = 'Minggu ini';
  } else if (period === 'month') {
    start = wibMidnightUtc(year, month, 1);
    label = 'Bulan ini';
  } else {
    start = wibMidnightUtc(year, month, day);
    label = 'Hari ini';
  }

  return {
    period,
    label,
    start,
    end: now
  };
}

function getDateRange(startDayKey, endDayKey = startDayKey, label = '') {
  const startParts = parseDayKey(startDayKey);
  const endParts = parseDayKey(endDayKey);

  if (!startParts || !endParts) {
    throw new Error('Tanggal tidak valid');
  }

  let first = startParts;
  let last = endParts;
  if (startParts.date > endParts.date) {
    first = endParts;
    last = startParts;
  }

  const endNextDay = wibMidnightUtc(last.year, last.month, last.day + 1);

  return {
    period: 'custom',
    label: label || toDayKey(first.date),
    start: first.date,
    end: new Date(endNextDay.getTime() - 1),
    startDayKey: toDayKey(first.date),
    endDayKey: toDayKey(last.date)
  };
}

function getDayKeys(start, end) {
  const keys = [];
  const startParts = toWibParts(start);
  const cursor = wibMidnightUtc(
    startParts.year,
    startParts.month,
    startParts.day
  );

  while (cursor <= end) {
    keys.push(toDayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
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
      order_intent: {}
    },
    eventIds: {},
    uniqueVisitorIds: {}
  };
}

function normalizeSummary(value, dayKey) {
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
  summary.sources.visitor ||= {};
  summary.sources.order_intent ||= {};
  summary.eventIds ||= {};
  summary.uniqueVisitorIds ||= {};

  return summary;
}

function incrementCount(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + value;
  }
}

function applyEventToSummary(summary, event) {
  if (summary.eventIds[event.id]) {
    return false;
  }

  summary.eventIds[event.id] = true;
  summary.totals[event.type] = (summary.totals[event.type] || 0) + 1;

  if (event.type === 'visitor') {
    incrementCount(summary.sources.visitor, event.source || 'Unknown');
    if (event.visitorId) {
      summary.uniqueVisitorIds[event.visitorId] = true;
    }
  }

  if (event.type === 'order_intent') {
    incrementCount(summary.sources.order_intent, event.source || 'Unknown');
  }

  return true;
}

async function updateDailySummary(store, event, dayKey) {
  const key = `summaries/${dayKey}.json`;
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await store.getWithMetadata(key, {
      type: 'json',
      consistency: 'strong'
    });
    const summary = normalizeSummary(existing?.data, dayKey);
    const changed = applyEventToSummary(summary, event);

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

  throw new Error(`Gagal update summary ${dayKey}`);
}

async function saveAnalyticsEvent(rawEvent) {
  const type = EVENT_TYPES.has(rawEvent?.type) ? rawEvent.type : null;
  if (!type) return null;

  const now = new Date();
  const event = {
    id: cleanKeyPart(rawEvent.eventId, `${type}-${crypto.randomUUID()}`),
    type,
    visitorId: cleanText(rawEvent.visitorId, '', 100),
    source: cleanText(rawEvent.source, 'Unknown', 100),
    sourceDetail: cleanText(rawEvent.sourceDetail, '', 300),
    device: cleanText(rawEvent.device, 'Unknown', 100),
    label: cleanText(rawEvent.label, '', 150),
    url: cleanText(rawEvent.url, '', 1000),
    timestamp: now.toISOString()
  };

  const store = await getAnalyticsStore();
  const dayKey = toDayKey(now);
  const eventKey = `events/${dayKey}/${event.id}.json`;
  const summaryResult = await updateDailySummary(store, event, dayKey);

  try {
    await store.setJSON(eventKey, event, { onlyIfNew: true });
  } catch (error) {
    console.error('[Analytics Event Log Error]', error);
  }

  return {
    ...event,
    counted: summaryResult.counted,
    duplicate: summaryResult.duplicate
  };
}

async function getSummaryForRange(range) {
  const store = await getAnalyticsStore();
  const dayKeys = getDayKeys(range.start, range.end);
  const summary = makeEmptySummary();

  const summaries = await Promise.all(
    dayKeys.map((dayKey) => store.get(`summaries/${dayKey}.json`, {
      type: 'json',
      consistency: 'strong'
    }))
  );

  for (const daySummary of summaries) {
    if (!daySummary) continue;

    for (const [type, total] of Object.entries(daySummary.totals || {})) {
      summary.totals[type] = (summary.totals[type] || 0) + total;
    }

    mergeCounts(summary.sources.visitor, daySummary.sources?.visitor);
    mergeCounts(summary.sources.order_intent, daySummary.sources?.order_intent);

    for (const visitorId of Object.keys(daySummary.uniqueVisitorIds || {})) {
      summary.uniqueVisitorIds[visitorId] = true;
    }
  }

  return { summary, range };
}

async function getSummaryForPeriod(period, now = new Date()) {
  return getSummaryForRange(getPeriodRange(period, now));
}

async function getEventsForPeriod(period, now = new Date()) {
  const range = getPeriodRange(period, now);
  const store = await getAnalyticsStore();
  const dayKeys = getDayKeys(range.start, range.end);
  const prefixes = period === 'month'
    ? [`events/${dayKeys[0].slice(0, 7)}-`]
    : dayKeys.map((dayKey) => `events/${dayKey}/`);
  const events = [];

  for (const prefix of prefixes) {
    for await (const result of store.list({
      prefix,
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

module.exports = {
  getDateRange,
  getEventsForPeriod,
  getPeriodRange,
  getSummaryForRange,
  getSummaryForPeriod,
  saveAnalyticsEvent,
  toDayKey
};
