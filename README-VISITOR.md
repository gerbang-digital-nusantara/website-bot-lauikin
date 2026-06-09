# Lauk.In Visitor Site

Project ini adalah web customer/link bio Lauk.In.

Event analytics dari browser dikirim ke endpoint lokal:

```text
/.netlify/functions/track-event
```

Endpoint tersebut akan meneruskan data ke web admin melalui environment variable:

```text
ADMIN_COLLECT_ENDPOINT
ADMIN_INGEST_SECRET
```

## Bisa jalan di dua mode

1. **Netlify** memakai `netlify/functions/track-event.js`.
2. **VPS Docker** memakai `server.js`, tetapi path endpoint tetap sama: `/.netlify/functions/track-event`.

## Environment Variables

```text
ADMIN_COLLECT_ENDPOINT=https://NAMA-WEB-ADMIN.netlify.app/.netlify/functions/collect-event
ADMIN_INGEST_SECRET=secret_random_yang_sama_dengan_admin
```

Untuk VPS Docker, lihat file `README-DEPLOY-VPS.md`.

## Event yang dikirim

- `visitor` saat halaman dibuka
- `order_intent` saat tombol Pesan Sekarang diklik
- `menu_click` saat gambar menu diklik
- `social_click` saat link sosial/maps diklik
