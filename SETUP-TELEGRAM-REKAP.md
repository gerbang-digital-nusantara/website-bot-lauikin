# Aktivasi Rekap Telegram

## 1. Tambahkan environment variable

Di Netlify buka **Project configuration > Environment variables**.

Pastikan tiga variable berikut tersedia untuk scope **Functions**:

```text
TELEGRAM_BOT_TOKEN=token_baru_dari_BotFather
TELEGRAM_CHAT_ID=chat_id_pemilik
TELEGRAM_WEBHOOK_SECRET=rahasia-acak-huruf-angka
```

Nilai `TELEGRAM_WEBHOOK_SECRET` hanya boleh berisi huruf, angka, `_`, dan `-`.

## 2. Deploy dengan dependency

Fitur ini memakai `@netlify/blobs`. Deploy drag-and-drop biasa tidak
menjalankan `npm install`, jadi gunakan repository Git atau Netlify CLI.

Contoh lewat PowerShell:

```powershell
npm install
npx netlify-cli login
npx netlify-cli link --name laukin-links
npx netlify-cli deploy --prod
```

## 3. Daftarkan webhook dan command bot

Setelah deploy selesai, jalankan:

```powershell
$secret = 'nilai-TELEGRAM_WEBHOOK_SECRET-yang-sama'
Invoke-RestMethod `
  -Uri 'https://laukin-links.netlify.app/.netlify/functions/telegram-setup' `
  -Method Post `
  -Headers @{ 'x-setup-secret' = $secret }
```

Respons yang benar:

```json
{
  "ok": true,
  "webhook": "https://laukin-links.netlify.app/.netlify/functions/telegram-webhook"
}
```

## 4. Cara kerja rekap terbaru

Setiap notifikasi yang berhasil dikirim ke Telegram juga disimpan ke Netlify
Blobs sebagai data rekap chat:

- `chat-events/YYYY-MM-DD/...` menyimpan pesan chat mentah yang sudah diparse.
- `chat-summaries/YYYY-MM-DD.json` menyimpan ringkasan harian agar `/rekap`
  cepat dan tidak perlu scan semua analytics.
- Tanggal rekap diambil dari baris `<b>Waktu:</b> ... WIB` yang ada di pesan
  Telegram, bukan dari waktu server saja.

Rekap utama sekarang membaca data chat Telegram tersimpan. Kalau ringkasan chat
belum lengkap, bot otomatis fallback ke ringkasan analytics harian agar data
`Pengunjung Baru` dan `Klik Mau Pesan` tetap kebaca tanpa scan besar. Analytics
lama tetap ada untuk pembanding lewat `/cekdata`.

## 5. Gunakan bot

Perintah yang tersedia:

```text
/hariini
/mingguini
/bulanini
/rekap
/rekap 2026-06-09
/rekap 09/06/2026
/rekap 9/6
/rekap 9
/rekap 9-10
/rekap 2026-06-01 2026-06-09
/cekdata 2026-06-09
```

Bot juga memahami kalimat seperti `tolong rekap minggu ini`,
`tolong rekap 8 juni 2026`, `tolong rekap 8-9 juni 2026`, atau
`rekap tanggal 9`.

Range tanggal custom dibatasi maksimal 62 hari agar rekap tetap cepat. Gunakan
`/cekdata` kalau ingin memastikan data chat dan data analytics tersimpan di
Netlify Blobs.

## 6. Catatan penting

Telegram Bot API tidak bisa membaca mundur seluruh pesan lama yang sudah ada di
chat sebelum fitur ini dideploy. Data rekap chat mulai lengkap setelah versi ini
dideploy, karena sejak saat itu setiap pesan notifikasi baru akan ikut disimpan
ke Netlify Blobs.
