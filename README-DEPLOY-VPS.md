# Deploy Lauk.In Web ke VPS

Project ini bisa jalan di VPS Docker pada folder:

```bash
/home/app/laukin-web
```

## File penting

- `Dockerfile` membangun image production.
- `server.js` menjalankan static website dan endpoint tracking `/.netlify/functions/track-event`.
- `docker-compose.yml` menjalankan container `laukin-web-container` pada port VPS `3084`.
- `.github/workflows/main.yml` build image ke GHCR lalu deploy ke VPS.
- `.env.example` contoh environment untuk VPS.

## Setup pertama di VPS

```bash
cd /home/app/laukin-web
cp .env.example .env
nano .env
```

Isi nilai ini sesuai web admin:

```env
APP_PORT=3084
PORT=4099
ADMIN_COLLECT_ENDPOINT=https://NAMA-WEB-ADMIN.netlify.app/.netlify/functions/collect-event
ADMIN_INGEST_SECRET=secret-yang-sama-dengan-admin
```

Jalankan container:

```bash
docker compose pull
docker compose up -d
docker compose ps
docker logs -f laukin-web-container
```

Test lokal VPS:

```bash
curl http://localhost:3084
curl http://localhost:3084/health
```

## Nginx reverse proxy

Ganti `web.domainkamu.com` dengan domain asli.

```nginx
server {
    listen 80;
    server_name web.domainkamu.com;

    location / {
        proxy_pass http://127.0.0.1:3084;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Aktifkan SSL:

```bash
certbot --nginx -d web.domainkamu.com
```
