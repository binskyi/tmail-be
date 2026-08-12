# Frontend Integration Guide

Dokumen ini merangkum semua fitur yang sudah tersedia di backend `tmail-be` dan apa saja yang perlu diintegrasikan di sisi frontend. Repo ini saat ini hanya berisi backend, jadi semua item frontend di dokumen ini dianggap belum diimplementasikan kecuali ada aplikasi frontend terpisah yang sudah memakainya.

## Ringkasan Backend

Backend ini adalah temporary email inbound-only. Sistem menerima SMTP lewat Haraka, memvalidasi domain penerima, menyimpan raw email ke spool lokal, memproses email lewat Redis Stream worker, menyimpan inbox metadata di Redis, menyimpan detail email ke file storage, mendeteksi OTP, dan mengirim update realtime lewat WebSocket.

Base API production:

```txt
https://prod.pusat.email/api/v1
```

Base path lokal:

```txt
/api/v1
```

Swagger UI:

```txt
/api/v1/swagger
```

OpenAPI JSON:

```txt
/api/v1/swagger.json
```

Admin API memakai header:

```http
X-Admin-Token: change-me-admin-token
```

Jika `ADMIN_TOKEN` belum diset, endpoint admin mengembalikan `503`.

## Status Implementasi Frontend

| Area | Status Backend | Status Frontend | Catatan |
| --- | --- | --- | --- |
| Generate temporary email | Sudah ada | Belum ada di repo ini | Perlu UI tombol generate dan copy email. |
| Inbox list | Sudah ada | Belum ada di repo ini | Perlu polling atau WebSocket untuk update. |
| Message detail | Sudah ada | Belum ada di repo ini | Perlu view text/html/raw dan OTP. |
| OTP display | Sudah ada | Belum ada di repo ini | Backend mengirim `is_otp` dan `otp`. |
| Delete message | Sudah ada | Belum ada di repo ini | Admin token required. |
| Delete inbox | Sudah ada | Belum ada di repo ini | Admin token required. |
| Public domain list | Sudah ada | Belum ada di repo ini | Untuk pilihan domain saat generate. |
| Random public domain list | Sudah ada | Belum ada di repo ini | Maksimal 10 domain acak untuk UI/domain suggestion. |
| Incoming MX-valid domain list | Sudah ada | Belum ada di repo ini | Pagination 20 item per halaman. |
| Domain status check | Sudah ada | Belum ada di repo ini | Bisa dipakai untuk validasi custom domain. |
| Admin domain registry | Sudah ada | Belum ada di repo ini | Add/delete/list/check domain. |
| Delete messages by domain | Sudah ada | Belum ada di repo ini | Admin token required. |
| System monitoring | Sudah ada | Belum ada di repo ini | CPU, RAM, Redis, Haraka, queue, storage. |
| WebSocket realtime inbox | Sudah ada | Belum ada di repo ini | Connect ke `/ws?email=...`. |
| Swagger UI | Sudah ada | Backend served | Bisa dibuka langsung dari API. |

## Recommended Frontend Screens

### Public Temporary Email Screen

Tujuan: user dapat membuat email sementara dan membaca inbox.

Fitur frontend yang perlu dibuat:

- Generate email random.
- Pilih domain public dari `GET /api/v1/domains`.
- Tampilkan opsi domain acak dari `GET /api/v1/random-domain` jika UI butuh suggestion ringkas.
- Copy email ke clipboard.
- Tampilkan inbox message list.
- Buka message detail.
- Tampilkan OTP secara jelas jika `is_otp=true`.
- Refresh inbox manual.
- Realtime update via WebSocket.
- Empty state saat inbox belum ada email.
- Error state untuk email invalid atau backend tidak tersedia.

Endpoint terkait:

- `GET /api/v1/generate`
- `GET /api/v1/generate?domain=example.com`
- `GET /api/v1/domains`
- `GET /api/v1/random-domain`
- `GET /api/v1/inbox?email=...`
- `GET /api/v1/messages/:id`
- `WS /ws?email=...`

### Domain Tools Screen

Tujuan: user/admin dapat mengecek status domain dan melihat domain incoming yang benar-benar terkoneksi ke MX sistem.

Fitur frontend yang perlu dibuat:

- Input domain dan tombol check status.
- Tampilkan status aktif/tidak aktif.
- Tampilkan `mx_valid`, `mx_records`, `required_mx`, dan `active_reason`.
- Tampilkan uptime approval domain jika aktif.
- Tampilkan list domain incoming MX-valid dengan pagination.
- Navigasi page dan indikator `total_pages` atau `last_page`.

Endpoint terkait:

- `GET /api/v1/domains/status?domain=example.com`
- `GET /api/v1/domains/:domain/status`
- `GET /api/v1/list-domain?page=1&limit=20`

### Admin Domain Management Screen

Tujuan: admin dapat mengelola domain aktif public/private.

Fitur frontend yang perlu dibuat:

- Form admin token atau mekanisme penyimpanan token di frontend.
- List semua domain aktif, termasuk private.
- Tambah domain public/private.
- Toggle atau input `verify_mx`.
- Cek status domain dari area admin.
- Delete domain.
- Delete semua messages untuk domain tertentu.
- Konfirmasi sebelum operasi delete.
- Error handling untuk `401`, `409`, dan `422`.

Endpoint terkait:

- `GET /api/v1/admin/domains`
- `POST /api/v1/admin/domains`
- `GET /api/v1/admin/domains/:domain/status`
- `DELETE /api/v1/admin/domains/:domain`
- `DELETE /api/v1/admin/domains/:domain/messages`

### Admin Inbox Operations Screen

Tujuan: admin dapat menghapus message atau inbox.

Fitur frontend yang perlu dibuat:

- Delete message dari detail message.
- Delete semua messages di inbox tertentu.
- Konfirmasi sebelum delete.
- Tampilkan hasil `file_deleted`, `inbox_entries_deleted`, dan recipients.

Endpoint terkait:

- `DELETE /api/v1/messages/:id`
- `DELETE /api/v1/inbox?email=...`

### Monitoring Screen

Tujuan: admin dapat memantau kondisi service.

Fitur frontend yang perlu dibuat:

- Status global `ok` atau `degraded`.
- App uptime dan host uptime.
- CPU usage total dan per core.
- RAM usage system dan process API.
- Redis online/offline, latency, uptime, memory, connected clients.
- Redis Stream queue length, first/last entry id, group info.
- Haraka SMTP online/offline, host, port, latency.
- API online, WebSocket enabled.
- Storage email/spool accessible dan disk usage.
- Auto refresh interval, misalnya 10-30 detik.
- Visual degraded state jika status `503`.

Endpoint terkait:

- `GET /api/v1/system/status`
- `GET /api/v1/health`

## Public API Detail

### Generate Temporary Email

```http
GET /api/v1/generate
```

Optional query:

- `domain`: domain public registered.

Response:

```json
{
  "email": "abc123@pusat.email",
  "domain": "pusat.email"
}
```

Frontend behavior:

- Simpan email aktif di state.
- Tampilkan tombol copy.
- Setelah generate, load inbox untuk email tersebut.
- Jika user memilih domain custom, gunakan `GET /api/v1/generate?domain=...`.

### Read Inbox

```http
GET /api/v1/inbox?email=abc123@pusat.email
```

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

Frontend behavior:

- Sort order sudah dari backend list Redis terbaru di depan.
- Klik item message untuk fetch detail.
- Tampilkan waktu dari `timestamp`.
- Jika `is_otp=true`, tampilkan `otp` langsung di list inbox tanpa fetch detail message.
- Handle empty list.

### Read Message Detail

```http
GET /api/v1/messages/:id
```

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

Frontend behavior:

- Jika `is_otp=true`, tampilkan `otp` sebagai highlight dan sediakan tombol copy.
- Tampilkan tab `text`, `html`, dan `raw` jika ingin lengkap.
- Render HTML email dengan hati-hati. Gunakan sandbox/iframe atau sanitization di frontend.
- Jika `404`, message sudah expired atau terhapus.

### List Public Domains

```http
GET /api/v1/domains
```

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

Frontend behavior:

- Pakai untuk select domain pada generate email.
- Hanya domain public yang muncul.
- Domain private tidak tampil dan tidak bisa dipilih public.

### Random Incoming Domains

```http
GET /api/v1/random-domain
```

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

Frontend behavior:

- Pakai untuk menampilkan suggestion dari domain incoming yang sudah MX-valid.
- Maksimal 10 domain dikembalikan.
- Sumber data digabung dari `/list-domain` dan domain yang pernah lolos check status MX.
- Domain yang sama hanya tampil sekali.
- `source=incoming` berarti dari email inbound, `source=mx_status` berarti dari check status domain.

### List Incoming Domains

```http
GET /api/v1/list-domain?page=1&limit=20
```

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

Frontend behavior:

- `limit` maksimal 20.
- Tampilkan pagination berdasarkan `total_pages` atau `last_page`.
- List ini hanya berisi domain yang MX-nya valid ke `REQUIRED_MX_HOST`.
- Data tidak otomatis expired.

### Check Domain Status

```http
GET /api/v1/domains/status?domain=example.com
GET /api/v1/domains/example.com/status
```

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

Frontend behavior:

- Tampilkan instruksi DNS jika `mx_valid=false`.
- `active_reason` bisa dipakai untuk label status.
- `visibility` bisa `public`, `private`, atau `null`.
- `built_in=true` berarti domain bawaan.

### Health Check

```http
GET /api/v1/health
```

Response:

```json
{
  "api": "ok",
  "redis": "ok",
  "smtp": "ok"
}
```

Frontend behavior:

- Cocok untuk lightweight banner status.
- Untuk monitoring detail, pakai `/system/status`.

## Admin API Detail

Semua endpoint di bagian ini butuh:

```http
X-Admin-Token: change-me-admin-token
```

### Delete Inbox

```http
DELETE /api/v1/inbox?email=abc123@pusat.email
```

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

Frontend behavior:

- Butuh confirmation dialog.
- Setelah sukses, clear inbox list untuk email tersebut.

### Delete Message

```http
DELETE /api/v1/messages/:id
```

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

Frontend behavior:

- Butuh confirmation dialog.
- Setelah sukses, remove item dari inbox list.

### Detailed System Status

```http
GET /api/v1/system/status
```

Response berisi objek besar:

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
  "host": {
    "hostname": "server-1",
    "platform": "linux",
    "arch": "x64",
    "release": "6.1.0",
    "uptime_seconds": 86400
  },
  "cpu": {
    "cores": 4,
    "model": "CPU model",
    "load_average": [0.2, 0.3, 0.4],
    "usage_percent": 12.5,
    "per_core": [
      { "core": 0, "usage_percent": 10 }
    ]
  },
  "memory": {
    "system": {
      "total_mb": 8192,
      "used_mb": 4096,
      "free_mb": 4096,
      "usage_percent": 50
    },
    "process": {
      "rss_mb": 120,
      "heap_total_mb": 64,
      "heap_used_mb": 32
    }
  },
  "services": {
    "redis": {
      "online": true,
      "latency_ms": 2,
      "uptime_seconds": 86400,
      "version": "7.x",
      "connected_clients": 4,
      "queue": {
        "stream": "email_queue",
        "group": "email_processors",
        "length": 0
      }
    },
    "haraka": {
      "online": true,
      "host": "127.0.0.1",
      "port": 2525,
      "latency_ms": 1
    },
    "api": {
      "online": true,
      "port": 3000,
      "uptime_seconds": 3600
    },
    "websocket": {
      "enabled": true
    }
  }
}
```

Frontend behavior:

- Jika HTTP status `503` atau `status=degraded`, tampilkan warning.
- Render CPU/RAM sebagai progress bars.
- Render Redis/Haraka/API sebagai service cards.
- Auto refresh dengan interval yang tidak terlalu agresif.

### List Admin Domains

```http
GET /api/v1/admin/domains
```

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

Frontend behavior:

- Tampilkan badge public/private.
- Built-in base domain bisa muncul dengan `built_in=true`.

### Add Admin Domain

```http
POST /api/v1/admin/domains
Content-Type: application/json

{
  "domain": "example.com",
  "visibility": "public",
  "verify_mx": true
}
```

Body:

- `domain` required.
- `visibility` optional, `public` atau `private`.
- `verify_mx` optional, default true.

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

Frontend behavior:

- Default `verify_mx=true`.
- Untuk development, bisa beri toggle `verify_mx=false`.
- Jika error `422`, tampilkan pesan bahwa MX harus mengarah ke required MX host.

### Admin Domain Status

```http
GET /api/v1/admin/domains/:domain/status
```

Response sama seperti public domain status.

Frontend behavior:

- Bisa dipakai dari row action di domain table.

### Delete Admin Domain

```http
DELETE /api/v1/admin/domains/:domain
```

Response:

```json
{
  "domain": "example.com",
  "deleted": true
}
```

Frontend behavior:

- Butuh confirmation dialog.
- Handle `409` untuk built-in base domain.

### Delete Domain Messages

```http
DELETE /api/v1/admin/domains/:domain/messages
```

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

Frontend behavior:

- Butuh confirmation dialog yang jelas karena efeknya mass delete.
- Setelah sukses, tampilkan jumlah inbox dan message yang terhapus.

## WebSocket Realtime

Connect:

```txt
ws://localhost:3000/ws?email=abc123@pusat.email
```

Jika API online memakai HTTPS, gunakan WSS:

```txt
wss://prod.pusat.email/ws?email=abc123@pusat.email
```

Event message:

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

Frontend behavior:

- Connect setelah email aktif tersedia.
- Jika email berubah, close socket lama dan buka socket baru.
- Saat event masuk, prepend message ke inbox list.
- Jika `message.is_otp=true`, tampilkan `message.otp` langsung dari event.
- Tetap sediakan fallback polling jika socket gagal.
- Handle close code `1008` untuk email invalid.

## Error Handling Frontend

Format error umum:

```json
{
  "error": "Invalid email"
}
```

Status yang perlu ditangani:

- `400`: input invalid.
- `401`: admin token salah.
- `404`: resource tidak ditemukan atau domain public tidak tersedia.
- `409`: konflik, misalnya delete built-in base domain.
- `422`: MX domain tidak sesuai requirement.
- `503`: admin API belum dikonfigurasi, Redis error, atau dependency degraded.

## Data Expiry dan Storage

Hal yang penting untuk UX:

- Email detail dan inbox punya TTL sesuai `EMAIL_TTL_SECONDS`, default 86400 detik.
- Inbox list maksimal `INBOX_MAX_MESSAGES`, default 20.
- Daily limit per inbox mengikuti `INBOX_DAILY_LIMIT`, default 50.
- List incoming domains tidak punya TTL.
- List incoming domains hanya berisi domain yang MX-valid ke `REQUIRED_MX_HOST`.
- Detail email bisa `404` jika sudah expired atau dihapus admin.

## Frontend Implementation Checklist

Gunakan checklist ini untuk melacak integrasi frontend.

### Public User

- [ ] Generate email default.
- [ ] Generate email dengan domain public pilihan.
- [ ] Random public domain suggestions.
- [ ] Copy email.
- [ ] Load inbox.
- [ ] Empty state inbox.
- [ ] Open message detail.
- [ ] Render text body.
- [ ] Render atau preview HTML body dengan sanitization.
- [ ] Copy OTP jika `is_otp=true`.
- [ ] WebSocket realtime inbox.
- [ ] Polling fallback untuk inbox.
- [ ] Domain status checker.
- [ ] Incoming domain list dengan pagination.

### Admin

- [ ] Input atau konfigurasi admin token.
- [ ] Delete message.
- [ ] Delete inbox.
- [ ] List admin domains.
- [ ] Add public domain.
- [ ] Add private domain.
- [ ] Toggle `verify_mx`.
- [ ] Admin domain status.
- [ ] Delete domain.
- [ ] Delete domain messages.
- [ ] System monitoring dashboard.
- [ ] Health check indicator.

### Documentation and Developer Tools

- [ ] Link ke Swagger UI.
- [ ] Link/download OpenAPI JSON.
- [ ] API base URL configuration.
- [ ] Error state mapping berdasarkan status code.
- [ ] Loading state untuk semua request.
- [ ] Confirmation dialog untuk destructive actions.

## Notes for Frontend Developers

- Jangan expose admin token ke public user. Admin screens harus dipisah dari public temporary email screen.
- Jangan render raw HTML email langsung ke DOM tanpa sanitization.
- Treat `timestamp`, `created_at`, `approved_at`, dan `last_seen_at` sebagai epoch milliseconds.
- Gunakan `total_pages` atau `last_page` dari `/list-domain` untuk pagination.
- Untuk monitoring, jangan refresh terlalu cepat. Interval 10-30 detik cukup untuk dashboard normal.
- Swagger adalah sumber kontrak API yang bisa dibuka di `/api/v1/swagger`.
