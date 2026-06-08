# Lauk.In Visitor Site

Project ini adalah web customer/link bio. Versi ini tidak mengirim data ke Telegram lagi.

Data dikirim ke web admin melalui:

```text
/.netlify/functions/track-event
```

Function tersebut meneruskan event ke:

```text
ADMIN_COLLECT_ENDPOINT
```

## Environment Variables Netlify

```text
ADMIN_COLLECT_ENDPOINT=https://NAMA-WEB-ADMIN.netlify.app/.netlify/functions/collect-event
ADMIN_INGEST_SECRET=secret_random_yang_sama_dengan_admin
```

Setelah env berubah, deploy ulang.

## Event yang dikirim

- `visitor` saat halaman dibuka
- `order_intent` saat tombol Pesan Sekarang diklik
- `menu_click` saat gambar menu diklik
- `social_click` saat link sosial/maps diklik
