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

## 4. Gunakan bot

Perintah yang tersedia:

```text
/hariini
/mingguini
/bulanini
/rekap
```

Bot juga memahami kalimat seperti `tolong rekap minggu ini`.

Data mulai dihitung setelah versi analytics ini dideploy. Pesan lama yang
sudah ada di Telegram tidak dapat dihitung mundur.
