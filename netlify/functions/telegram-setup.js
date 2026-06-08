const { callTelegram } = require('../lib/telegram');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || event.headers?.['x-setup-secret'] !== secret) {
    return jsonResponse(401, { ok: false, error: 'Unauthorized' });
  }

  try {
    const siteUrl = String(process.env.URL || '').replace(/\/$/, '');
    if (!siteUrl) throw new Error('URL situs Netlify tidak tersedia');

    await callTelegram('setWebhook', {
      url: `${siteUrl}/.netlify/functions/telegram-webhook`,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });

    await callTelegram('setMyCommands', {
      commands: [
        { command: 'hariini', description: 'Rekap hari ini' },
        { command: 'mingguini', description: 'Rekap minggu ini' },
        { command: 'bulanini', description: 'Rekap bulan ini' },
        { command: 'rekap', description: 'Rekap per tanggal/range dari chat' },
        { command: 'cekdata', description: 'Cek data rekap chat tersimpan' }
      ]
    });

    return jsonResponse(200, {
      ok: true,
      webhook: `${siteUrl}/.netlify/functions/telegram-webhook`
    });
  } catch (error) {
    console.error('[Telegram Setup Error]', error);
    return jsonResponse(500, {
      ok: false,
      error: error.message
    });
  }
};
