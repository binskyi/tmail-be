# Temporary Email Backend

Backend inbound-only untuk temporary email. Sistem menerima SMTP via Haraka, memvalidasi catch-all domain, menaruh raw email ke spool lokal, memproses email lewat Redis Stream worker, menyimpan metadata inbox di Redis dengan TTL 1 hari, dan menyimpan detail body email ke file system.

## Fitur

- SMTP inbound-only dengan Haraka.
- Catch-all untuk `pusat.email` dan semua subdomainnya.
- Custom domain tanpa registrasi, valid otomatis jika MX mengarah ke `mail.pusat.email`.
- Redis Stream queue untuk memisahkan SMTP accept path dari parsing/storage email.
- Redis hot storage per inbox dengan TTL 86400 detik.
- Spool raw email lokal di `spool/emails/YYYY-MM-DD/HH/*.eml`.
- File cold storage sharded di `emails/YYYY-MM-DD/aa/bb/{uuid}.json`.
- Express API `/api/v1`.
- Validasi email input dan limit 50 email per inbox per hari.
- Worker email queue untuk parse raw email async.
- Worker cleanup file email lebih dari 1 hari.
- WebSocket update inbox saat email masuk.
- Admin API untuk tambah/hapus domain aktif dan hapus pesan.
- Admin web `/admin` untuk mengatur whitelist IP akses API HTTP.
- Deteksi OTP otomatis dengan regex lokal, fallback OpenAI opsional, dan Redis template learning agar tidak hit AI terus-menerus untuk pola email yang sama.

## Setup

```bash
cp .env.example .env
bun install
```

Set `ADMIN_TOKEN` di `.env`. Semua endpoint admin dan delete memakai header:

```txt
X-Admin-Token: change-me-admin-token
```

Admin web tersedia di:

```txt
/admin
```

Default password:

```txt
Premium@123
```

Sebaiknya override di production:

```env
ADMIN_WEB_PASSWORD=password-kuat
ADMIN_SESSION_SECRET=random-secret-panjang
```

Menu `/admin` dipakai untuk memilih mode akses API HTTP:

- `All IP`: semua IP bisa akses API HTTP.
- `Whitelist only`: hanya IP di whitelist yang bisa akses API HTTP.

Endpoint `/admin` dan WebSocket `/ws` selalu bisa diakses tanpa whitelist supaya admin tidak terkunci dari menu pengaturan dan realtime inbox tetap berjalan.

## Cloudflare Tunnel

Cloudflare Tunnel bisa dipakai untuk Express API dan WebSocket saja:

```txt
https://prod.pusat.email -> http://127.0.0.1:3000
wss://prod.pusat.email/ws -> ws://127.0.0.1:3000/ws
```

Redis tetap lokal, dan Haraka SMTP tetap harus menerima email lewat MX/port 25 langsung ke VPS. Jangan arahkan SMTP melalui Cloudflare Tunnel.
API memakai `TRUST_PROXY=1` supaya Express membaca IP client dari proxy/tunnel. Jika API benar-benar diekspos langsung tanpa reverse proxy, set `TRUST_PROXY=0`.

Untuk development cepat tanpa named tunnel, install `cloudflared`, lalu set di `.env`:

```env
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_TUNNEL_MODE=quick
CLOUDFLARE_TUNNEL_URL=http://127.0.0.1:3000
TRUST_PROXY=1
```

Setelah itu:

```bash
bun dev
```

`bun dev` akan menjalankan API, workers, Haraka, Redis dev, dan `cloudflared tunnel --url http://127.0.0.1:3000`.

Untuk named tunnel production, pakai salah satu opsi berikut.

Token tunnel:

```env
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_TUNNEL_TOKEN=token-dari-cloudflare
```

Config file tunnel:

```env
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_TUNNEL_CONFIG=./cloudflared/config.yml
CLOUDFLARE_TUNNEL_NAME=tmail-api
```

Contoh config tersedia di `cloudflared/config.yml.example`. Copy dulu:

```bash
cp cloudflared/config.yml.example cloudflared/config.yml
```

Isi `cloudflared/config.yml`:

```yaml
tunnel: tmail-api
credentials-file: ./cloudflared/tmail-api.json

ingress:
  - hostname: prod.pusat.email
    service: http://127.0.0.1:3000
  - service: http_status:404
```

DNS Cloudflare:

```txt
prod.pusat.email -> tunnel route
mail.pusat.email -> A VPS_IP, DNS only
pusat.email      -> MX 10 mail.pusat.email
```

Pastikan Redis aktif:

```bash
redis-server --requirepass d0535500cb173f97
```

Konfigurasi Redis default:

```env
REDIS_PASSWORD=d0535500cb173f97
REDIS_URL=redis://:d0535500cb173f97@127.0.0.1:6379
```

## OTP Detection

Setiap detail message dari `GET /api/v1/messages/:id` otomatis ditambah:

```json
{
  "is_otp": true,
  "otp": "123456"
}
```

Jika email bukan OTP, response tetap memakai field yang sama:

```json
{
  "is_otp": false,
  "otp": null
}
```

Alur deteksi OTP:

- Regex lokal dijalankan lebih dulu.
- Redis exact template cache dipakai untuk pola email yang sama persis.
- Redis fallback template cache dipakai untuk sender dan subject pattern yang sama walaupun body berubah.
- Learned extraction rule menyimpan konteks sebelum/sesudah kode agar OTP baru bisa diambil tanpa OpenAI.
- OpenAI hanya dipanggil kalau email ambigu, cache belum ada, dan `OTP_AI_ENABLED=true`.
- Hasil OpenAI disimpan ke Redis sebagai template OTP/non-OTP untuk menghemat token pada email berikutnya.

Konfigurasi:

```env
OPENAI_API_KEY=sk-proj-your-openai-api-key
OPENAI_MODEL=gpt-4.1-mini
OTP_AI_ENABLED=true
OTP_TEMPLATE_CACHE_TTL_SECONDS=2592000
OTP_AI_MAX_BODY_CHARS=3000
OTP_AI_DAILY_LIMIT=500
```

Catatan:

- Simpan API key asli hanya di `.env` atau deployment secrets, jangan commit key asli ke repo.
- Set `OTP_AI_ENABLED=false` untuk mode full lokal tanpa OpenAI.
- `OTP_AI_DAILY_LIMIT=0` berarti tidak ada batas harian.

Jalankan semua service development:

```bash
bun dev
```

Command ini menjalankan Redis jika `redis-server` tersedia. Jika tidak, command akan mencoba menjalankan Docker container `redis:7-alpine`. Setelah itu API, worker cleanup, dan Haraka ikut dijalankan. Port Haraka dibaca dari `HARAKA_SMTP_PORT` di `.env`.
Redis dev akan dijalankan dengan `requirepass` dari `REDIS_PASSWORD`.

Redis dev dibuat tetap hidup saat `bun dev` dihentikan, sehingga data seperti domain registry dan whitelist IP tidak hilang hanya karena script backend direstart. Redis dev tetap volatile karena persistence disk dimatikan; data akan hilang jika proses/container Redis dimatikan manual atau server reboot.

Untuk menghentikan Redis dev manual:

```bash
redis-cli -a d0535500cb173f97 shutdown
```

Jika Redis dev berjalan lewat Docker:

```bash
docker stop tmail-redis-dev
docker rm tmail-redis-dev
```

Jika muncul pesan Redis belum tersedia dan Docker juga tidak siap, install Redis dulu:

```bash
brew install redis
```

Setelah itu cukup jalankan lagi:

```bash
bun dev
```

Jalankan API saja:

```bash
bun start
```

Jalankan worker cleanup saja:

```bash
bun run worker:cleanup
```

Jalankan worker email queue saja:

```bash
bun run worker:email
```

Jalankan Haraka saja:

```bash
bun run haraka:start
```

Untuk mengubah port Haraka tanpa edit config:

```env
HARAKA_SMTP_PORT=2525
```

`bun dev` dan `bun run haraka:start` akan menulis ulang `haraka/config/smtp.ini` dari env sebelum Haraka dijalankan.

Untuk production SMTP port 25, set:

```env
HARAKA_SMTP_PORT=25
```

Lalu jalankan Haraka lewat service manager dengan permission yang sesuai.

## Podman

### Podman Compose

Cara paling mudah menjalankan semua service di VPS:

```bash
apt update
apt install -y podman podman-compose
```

Pastikan `.env` untuk container memakai host Redis `redis`, bukan `127.0.0.1`:

```env
REDIS_PASSWORD=ganti-password-kuat
REDIS_URL=redis://:ganti-password-kuat@redis:6379

EMAIL_STORAGE_DIR=/app/emails
EMAIL_SPOOL_DIR=/app/spool/emails

HARAKA_SMTP_HOST=0.0.0.0
HARAKA_SMTP_PORT=25
```

Build dan jalankan semua service:

```bash
podman-compose up -d --build
```

Service yang dijalankan:

- `tmail-redis`
- `tmail-api`
- `tmail-email-worker`
- `tmail-cleanup`
- `tmail-haraka`

Cek status dan log:

```bash
podman-compose ps
podman-compose logs -f
```

Test API dari VPS:

```bash
curl http://127.0.0.1:3000/api/v1/health
```

Stop semua:

```bash
podman-compose down
```

API hanya dibind ke `127.0.0.1:3000`, jadi cocok dipakai bersama Cloudflare Tunnel di host. SMTP Haraka dibind ke host port `25`.

### Manual Podman

Build image aplikasi:

```bash
podman build -t tmail-be:latest -f Containerfile .
```

Buat network dan volume lokal:

```bash
podman network create tmail-net
podman volume create tmail-redis
podman volume create tmail-emails
podman volume create tmail-spool
```

Buat env khusus container, misalnya `.env.podman`:

```env
NODE_ENV=production
PORT=3000
TRUST_PROXY=1

BASE_DOMAIN=pusat.email
REQUIRED_MX_HOST=mail.pusat.email

REDIS_PASSWORD=ganti-password-kuat
REDIS_URL=redis://:ganti-password-kuat@redis:6379

HARAKA_SMTP_HOST=0.0.0.0
HARAKA_SMTP_PORT=2525
HARAKA_SMTP_NODES=0

EMAIL_STORAGE_DIR=/app/emails
EMAIL_SPOOL_DIR=/app/spool/emails
EMAIL_TTL_SECONDS=86400
INBOX_MAX_MESSAGES=20
INBOX_DAILY_LIMIT=50
EMAIL_QUEUE_STREAM=email_queue
EMAIL_QUEUE_GROUP=email_processors
EMAIL_QUEUE_BATCH_SIZE=10
EMAIL_QUEUE_MAXLEN=100000
DOMAIN_MX_CACHE_TTL_SECONDS=3600

ADMIN_TOKEN=ganti-token-admin-kuat
ADMIN_WEB_PASSWORD=Premium@123
ADMIN_SESSION_SECRET=random-secret-panjang

OPENAI_API_KEY=sk-proj-your-openai-api-key
OPENAI_MODEL=gpt-4.1-mini
OTP_AI_ENABLED=true
OTP_TEMPLATE_CACHE_TTL_SECONDS=2592000
OTP_AI_MAX_BODY_CHARS=3000
OTP_AI_DAILY_LIMIT=500

WS_ENABLED=true
```

Jalankan Redis:

```bash
podman run -d \
  --name tmail-redis \
  --network tmail-net \
  -v tmail-redis:/data \
  redis:7-alpine \
  redis-server --appendonly yes --requirepass ganti-password-kuat
```

Jalankan API:

```bash
podman run -d \
  --name tmail-api \
  --network tmail-net \
  --env-file .env.podman \
  -p 3000:3000 \
  -v tmail-emails:/app/emails \
  tmail-be:latest \
  bun src/app.js
```

Jalankan worker email queue:

```bash
podman run -d \
  --name tmail-email-worker \
  --network tmail-net \
  --env-file .env.podman \
  -v tmail-emails:/app/emails \
  -v tmail-spool:/app/spool \
  tmail-be:latest \
  bun src/workers/emailQueue.js
```

Jalankan worker cleanup:

```bash
podman run -d \
  --name tmail-cleanup \
  --network tmail-net \
  --env-file .env.podman \
  -v tmail-emails:/app/emails \
  tmail-be:latest \
  bun src/workers/cleanup.js
```

Jalankan Haraka SMTP. Untuk test lokal gunakan port `2525`:

```bash
podman run -d \
  --name tmail-haraka \
  --network tmail-net \
  --env-file .env.podman \
  -p 2525:2525 \
  -v tmail-spool:/app/spool \
  tmail-be:latest \
  bun src/harakaStart.js
```

Cek log:

```bash
podman logs -f tmail-haraka
podman logs -f tmail-email-worker
```

Test API:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/generate
```

Untuk production SMTP port `25`, ada dua opsi.

Opsi pertama, jalankan container Haraka dengan port `25`:

```bash
podman rm -f tmail-haraka
sed -i 's/HARAKA_SMTP_PORT=2525/HARAKA_SMTP_PORT=25/' .env.podman

sudo podman run -d \
  --name tmail-haraka \
  --network tmail-net \
  --env-file .env.podman \
  -p 25:25 \
  -v tmail-spool:/app/spool \
  tmail-be:latest \
  bun src/harakaStart.js
```

Opsi kedua, Haraka tetap listen `2525`, lalu redirect port host `25` ke `2525` memakai firewall. Ini membuat proses aplikasi tidak perlu bind langsung ke privileged port. Aturan firewall berbeda per distro, jadi sesuaikan dengan `nftables`, `iptables`, atau firewall panel VPS.

Stop semua service:

```bash
podman rm -f tmail-haraka tmail-cleanup tmail-email-worker tmail-api tmail-redis
```

Catatan Podman:

- Semua container harus berada di network `tmail-net`.
- `tmail-spool` harus dipakai bersama oleh Haraka dan email worker.
- `tmail-emails` harus dipakai bersama oleh API, email worker, dan cleanup worker.
- Jangan expose Redis ke internet.
- Untuk jutaan email/hari di satu VPS, batasi ukuran email di `haraka/config/connection.ini`, misalnya `[max] bytes=1048576`.
- Rootless Podman biasanya tidak bisa bind port `25` langsung; gunakan rootful Podman atau redirect firewall.

## Haraka Config

Plugin aktif didefinisikan di `haraka/config/plugins`:

```txt
validate_rcpt
save_email
```

Host MX custom domain harus mengarah ke:

```txt
mail.pusat.email
```

Contoh DNS:

```txt
example.com.  MX 10 mail.pusat.email.
*.example.com. MX 10 mail.pusat.email.
```

## API

Base URL production: `https://prod.pusat.email/api/v1`

Base path lokal: `/api/v1`

Semua endpoint di bawah juga tersedia di Swagger UI:

```http
GET /api/v1/swagger
```

OpenAPI JSON mentah:

```http
GET /api/v1/swagger.json
```

Contoh URL lokal:

```txt
http://127.0.0.1:3000/api/v1/swagger
```

Contoh URL online:

```txt
https://prod.pusat.email/api/v1/swagger
```

Endpoint admin memakai header:

```http
X-Admin-Token: change-me-admin-token
```

Jika `ADMIN_TOKEN` belum diset, endpoint admin mengembalikan `503`.

### Public API

#### Generate Temporary Email

```http
GET /api/v1/generate
```

Membuat alamat email random memakai domain public default.

Query parameter:

- `domain` optional, string. Jika diisi, domain harus domain registered public.

Contoh:

```http
GET /api/v1/generate?domain=example.com
```

Response:

```json
{ "email": "abc123@pusat.email", "domain": "pusat.email" }
```

Kemungkinan error:

- `404` jika `domain` diminta tetapi tidak tersedia untuk public generation.

#### Read Inbox

```http
GET /api/v1/inbox?email=abc123@pusat.email
```

Membaca list message pendek dari Redis untuk satu inbox.

Query parameter:

- `email` required, format email valid.

Response:

```json
{
  "email": "abc123@pusat.email",
  "messages": [
    {
      "id": "d2fb0b7c-7a8d-4fb0-bc37-4e0f95f67d3b",
      "from": "Service <no-reply@example.com>",
      "subject": "Your verification code",
      "timestamp": 1710000000000,
      "is_otp": true,
      "otp": "123456"
    }
  ]
}
```

Kemungkinan error:

- `400` jika email tidak valid.

#### Delete Inbox

```http
DELETE /api/v1/inbox?email=abc123@pusat.email
X-Admin-Token: change-me-admin-token
```

Menghapus semua message yang ada di inbox email tersebut dari Redis inbox dan file storage.

Auth: admin token required.

Query parameter:

- `email` required, format email valid.

Response:

```json
{
  "email": "abc123@pusat.email",
  "messages_deleted": 2,
  "message_ids": [
    "d2fb0b7c-7a8d-4fb0-bc37-4e0f95f67d3b"
  ]
}
```

Kemungkinan error:

- `400` jika email tidak valid.
- `401` jika admin token salah.
- `503` jika admin token belum dikonfigurasi.

#### Read Message Detail

```http
GET /api/v1/messages/:id
```

Membaca detail email dari file storage.

Path parameter:

- `id` required, UUID message.

Response:

```json
{
  "id": "d2fb0b7c-7a8d-4fb0-bc37-4e0f95f67d3b",
  "from": "Service <no-reply@example.com>",
  "to": ["abc123@pusat.email"],
  "subject": "Your verification code",
  "text": "Use code 123456 to login.",
  "html": "",
  "raw": "...",
  "created_at": 1710000000000,
  "is_otp": true,
  "otp": "123456"
}
```

Jika email bukan OTP, field tetap ada:

```json
{
  "is_otp": false,
  "otp": null
}
```

Kemungkinan error:

- `400` jika message id tidak valid.
- `404` jika message tidak ditemukan.

#### Delete Message

```http
DELETE /api/v1/messages/:id
X-Admin-Token: change-me-admin-token
```

Hapus satu pesan dari Redis inbox dan file storage.

Auth: admin token required.

Path parameter:

- `id` required, UUID message.

Response:

```json
{
  "message_id": "d2fb0b7c-7a8d-4fb0-bc37-4e0f95f67d3b",
  "deleted": true,
  "inbox_entries_deleted": 1,
  "file_deleted": true,
  "recipients": ["abc123@pusat.email"]
}
```

Kemungkinan error:

- `400` jika message id tidak valid.
- `401` jika admin token salah.
- `404` jika message tidak ditemukan.
- `503` jika admin token belum dikonfigurasi.

#### List Incoming Domains

```http
GET /api/v1/list-domain?page=1&limit=20
```

Menampilkan domain penerima yang pernah masuk ke sistem, sudah diproses worker, dan MX domainnya valid mengarah ke `REQUIRED_MX_HOST`. Domain yang tidak terkoneksi ke MX sistem tidak disimpan ke list ini. Data disimpan di Redis lokal saat email inbound diproses. Endpoint memakai pagination agar response tidak terlalu besar.

Query parameter:

- `page`: nomor halaman, default `1`
- `limit`: jumlah domain per halaman, default `20`, maksimal `20`

Response:

```json
{
  "page": 1,
  "limit": 20,
  "total_domains": 45,
  "total_pages": 3,
  "last_page": 3,
  "domains": [
    {
      "domain": "example.com",
      "last_seen_at": 1710000000000,
      "total_messages": 12,
      "mx_valid": true
    }
  ]
}
```

Catatan storage:

- domain disimpan di Redis sorted set `domains:incoming:mx_valid`
- counter disimpan di `domain_incoming_count:{domain}`
- list ini tidak memakai TTL

#### List Public Domains

```http
GET /api/v1/domains
```

Menampilkan domain public aktif yang boleh dipakai untuk generate email.

Response:

```json
{
  "domains": [
    {
      "domain": "pusat.email",
      "visibility": "public",
      "created_at": 0,
      "updated_at": 0,
      "built_in": true
    }
  ]
}
```

#### Random Incoming Domains

```http
GET /api/v1/random-domain
```

Menampilkan gabungan domain incoming yang MX-valid dan domain yang pernah dicek status lalu valid MX. Hasil diacak, maksimal 10 domain, dan domain yang sama hanya tampil sekali.

Response:

```json
{
  "domains": [
    {
      "domain": "pusat.email",
      "last_seen_at": 1779811148095,
      "total_messages": 8,
      "mx_valid": true,
      "source": "incoming"
    }
  ],
  "total_domains": 5,
  "limit": 10
}
```

Nilai `source`:

- `incoming`: domain tercatat dari email inbound.
- `mx_status`: domain tercatat dari hasil check status domain yang MX-valid.

#### Check Domain Status

```http
GET /api/v1/domains/status?domain=example.com
```

Alternatif path parameter:

```http
GET /api/v1/domains/example.com/status
```

Cek apakah domain aktif untuk inbound. Domain dianggap aktif jika salah satu kondisi ini benar:

- domain adalah `BASE_DOMAIN` atau subdomainnya
- domain terdaftar aktif di admin registry
- MX domain mengarah ke `mail.pusat.email`

Response:

```json
{
  "domain": "example.com",
  "active": true,
  "approved": true,
  "approved_at": 1777885500393,
  "uptime_seconds": 4492800,
  "uptime_days": 52,
  "uptime_label": "52 days",
  "status_label": "Domain approved (uptime 52 days)",
  "registered": false,
  "visibility": null,
  "built_in": false,
  "mx_valid": true,
  "mx_records": [
    { "exchange": "mail.pusat.email", "priority": 10 }
  ],
  "required_mx": "mail.pusat.email",
  "active_reason": "mx_points_to_required_host",
  "created_at": null,
  "updated_at": null
}
```

Kemungkinan error:

- `400` jika domain tidak valid.

#### Health Check

```http
GET /api/v1/health
```

Health check public yang ringan untuk API dan Redis.

Response:

```json
{ "api": "ok", "redis": "ok", "smtp": "ok" }
```

Kemungkinan status:

- `200` jika Redis bisa di-ping.
- `503` jika Redis error.

### Admin Monitoring API

#### Detailed System Status

```http
GET /api/v1/system/status
X-Admin-Token: change-me-admin-token
```

Menampilkan status operasional detail untuk monitoring internal. Endpoint ini memakai admin token karena response berisi informasi server.

Isi response meliputi:

- uptime aplikasi dan host
- current downtime status aplikasi, Redis, dan Haraka
- CPU usage total dan per core
- RAM usage sistem dan process API
- status Redis, latency, uptime, memory, client, dan Redis Stream queue email
- status Haraka SMTP berdasarkan koneksi TCP ke host/port health check
- status storage email dan spool, termasuk disk usage jika runtime mendukung `statfs`
- status WebSocket

Default host health check Haraka:

```env
HARAKA_HEALTH_HOST=127.0.0.1
```

Jika API dan Haraka berjalan di container berbeda, set `HARAKA_HEALTH_HOST` ke hostname service Haraka, misalnya:

```env
HARAKA_HEALTH_HOST=haraka
```

Contoh response ringkas:

```json
{
  "status": "ok",
  "timestamp": 1710000000000,
  "app": {
    "name": "tmail-be",
    "env": "production",
    "pid": 123,
    "uptime_seconds": 3600,
    "current_downtime": { "active": false, "seconds": 0 }
  },
  "cpu": {
    "cores": 4,
    "usage_percent": 12.5
  },
  "memory": {
    "system": {
      "total_mb": 8192,
      "used_mb": 4096,
      "usage_percent": 50
    }
  },
  "services": {
    "redis": {
      "online": true,
      "latency_ms": 2,
      "uptime_seconds": 86400
    },
    "haraka": {
      "online": true,
      "host": "127.0.0.1",
      "port": 2525
    },
    "api": {
      "online": true,
      "port": 3000
    }
  }
}
```

Kemungkinan status:

- `200` jika dependency utama online.
- `503` jika Redis atau Haraka degraded.
- `401` jika admin token salah.
- `503` jika admin token belum dikonfigurasi.

### Admin Domain API

#### List All Active Domains

List semua domain aktif, termasuk private.

```http
GET /api/v1/admin/domains
X-Admin-Token: change-me-admin-token
```

Auth: admin token required.

Response:

```json
{
  "domains": [
    {
      "domain": "example.com",
      "visibility": "public",
      "created_at": 1710000000000,
      "updated_at": 1710000000000
    }
  ]
}
```

#### Admin Check Domain Status

```http
GET /api/v1/admin/domains/example.com/status
X-Admin-Token: change-me-admin-token
```

Auth: admin token required.

Path parameter:

- `domain` required.

Response sama seperti public domain status, tetapi endpoint ini ada di area admin.

#### Add Domain

Tambah domain public:

```http
POST /api/v1/admin/domains
X-Admin-Token: change-me-admin-token
Content-Type: application/json

{
  "domain": "example.com",
  "visibility": "public"
}
```

Auth: admin token required.

Body:

- `domain` required, string domain valid.
- `visibility` optional, `public` atau `private`, default `public`.
- `verify_mx` optional, boolean, default `true`.

Tambah domain private:

```http
POST /api/v1/admin/domains
X-Admin-Token: change-me-admin-token
Content-Type: application/json

{
  "domain": "internal-example.com",
  "visibility": "private"
}
```

`public` berarti domain tampil di `GET /api/v1/domains` dan bisa dipakai di `/generate?domain=...`.
`private` berarti domain aktif untuk inbound, tetapi tidak ditampilkan ke user public dan tidak bisa dipilih untuk generate public.

Secara default API tambah domain memverifikasi MX harus mengarah ke `mail.pusat.email`. Untuk development lokal bisa override:

```json
{
  "domain": "example.test",
  "visibility": "private",
  "verify_mx": false
}
```

Response:

```json
{
  "domain": {
    "domain": "example.com",
    "visibility": "public",
    "created_at": 1710000000000,
    "updated_at": 1710000000000
  }
}
```

Kemungkinan error:

- `400` jika domain invalid atau visibility bukan `public`/`private`.
- `401` jika admin token salah.
- `422` jika `verify_mx=true` dan MX tidak mengarah ke `REQUIRED_MX_HOST`.

#### Delete Domain

Hapus domain dari daftar aktif.

```http
DELETE /api/v1/admin/domains/example.com
X-Admin-Token: change-me-admin-token
```

Auth: admin token required.

Path parameter:

- `domain` required.

Response:

```json
{
  "domain": "example.com",
  "deleted": true
}
```

Kemungkinan error:

- `400` jika domain invalid.
- `401` jika admin token salah.
- `404` jika domain tidak ditemukan.
- `409` jika mencoba menghapus built-in base domain.

#### Delete Domain Messages

Hapus semua pesan untuk domain tertentu.

```http
DELETE /api/v1/admin/domains/example.com/messages
X-Admin-Token: change-me-admin-token
```

Auth: admin token required.

Path parameter:

- `domain` required.

Response:

```json
{
  "domain": "example.com",
  "inboxes_deleted": 3,
  "messages_deleted": 12,
  "message_ids": [
    "d2fb0b7c-7a8d-4fb0-bc37-4e0f95f67d3b"
  ]
}
```

Catatan: domain yang tidak diregistrasikan tetap bisa diterima otomatis jika MX domain tersebut mengarah ke `mail.pusat.email`. Registry domain admin dipakai untuk mengatur domain aktif public/private dan menu operasional.

## WebSocket

Connect ke:

```txt
ws://localhost:3000/ws?email=abc123@pusat.email
```

Saat email masuk, server mengirim event:

```json
{
  "type": "message",
  "email": "abc123@pusat.email",
  "message": {
    "id": "uuid",
    "from": "sender@example.com",
    "subject": "Hello",
    "timestamp": 1710000000000,
    "is_otp": false,
    "otp": null
  }
}
```

## Catatan Skala

Redis menyimpan list inbox pendek, Redis Stream hanya menyimpan pointer spool, dan raw email ditulis ke disk supaya RAM Redis tidak habis oleh body email. Body final disimpan sharded per UUID agar satu folder tidak berisi jutaan file.

Untuk VPS tunggal, wajib batasi ukuran email, TTL, queue length, dan pantau disk. Contoh batas aman untuk temporary email text/OTP adalah 512 KB sampai 1 MB per email. Jika traffic benar-benar jutaan email/hari, kapasitas utama yang harus dipantau adalah disk I/O, free disk, Redis memory, dan lag worker email queue.
