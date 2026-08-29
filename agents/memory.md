# Memory Proyek — OpenWA (Nawasena Edition)

> **Purpose**: OpenWA di-_strip_ menjadi **lean unofficial WhatsApp engine** yang melayani nawasena-chat-backend sebagai alternatif koneksi selain Meta Cloud API resmi.
>
> **Update dokumen ini** setiap kali ada perubahan arsitektur besar.

---

## 1. Ringkasan & Visi

### Konteks Ekosistem

```
┌─────────────────────────────────────────────────────────────────────┐
│                     nawasena-chat (Frontend)                        │
│                React 19 + Vite + Zustand + Tailwind                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP / WebSocket
┌──────────────────────────────▼──────────────────────────────────────┐
│                  nawasena-chat-backend (Hono/Bun)                   │
│                                                                     │
│   ┌─────────────────┐   ┌──────────────────────────────────────┐   │
│   │  Official Mode  │   │        Unofficial Mode               │   │
│   │  Meta Graph API │   │  nawasena → OpenWA REST → WhatsApp   │   │
│   │  (v21.0/v22.0)  │   │  OpenWA webhook → nawasena           │   │
│   └────────┬────────┘   └──────────────────┬───────────────────┘   │
│            │                               │                       │
│   Payload format IDENTIK ←── Mapping ──→ Payload format IDENTIK   │
│   (Meta Webhook JSON)                    (Meta Webhook JSON)       │
└────────────┬───────────────────────────────┬───────────────────────┘
             │                               │
     Meta Cloud API               OpenWA (self-hosted)
     (official, bayar)            (unofficial, gratis)
                                        │
                                  WhatsApp Web
                              (wwebjs / Baileys engine)
```

### Misi OpenWA dalam Ekosistem Nawasena

1. **Hanya** berfungsi sebagai **WhatsApp engine gateway** — terima perintah kirim pesan via REST, kirim webhook ke nawasena-backend saat ada pesan masuk
2. **Webhook payload harus identik** dengan format Meta Graph API Webhook — nawasena-backend cukup routing berdasarkan `platform` di tabel `channels`
3. **Adopsi penuh protokol keamanan** untuk meminimalkan risiko ban/restriction WhatsApp
4. **Lean**: hapus semua module yang tidak diperlukan — dashboard, plugin, MCP, n8n, dll.

---

## 2. Tech Stack (Tidak Berubah)

| Layer     | Technology                                                  |
| --------- | ----------------------------------------------------------- |
| Runtime   | Node.js 22 LTS                                              |
| Framework | NestJS 11.x                                                 |
| Language  | TypeScript 6.x                                              |
| WA Engine | Pluggable: whatsapp-web.js (default, recommended) / Baileys |
| Database  | SQLite (cukup — single purpose gateway)                     |
| ORM       | TypeORM                                                     |
| Container | Docker + Docker Compose                                     |

> PostgreSQL, Redis, S3/MinIO, BullMQ queue **tidak diperlukan** untuk use case ini.
> SQLite cukup karena OpenWA hanya menyimpan session state + webhook config, bukan histori pesan (nawasena yang menyimpan).

---

## 3. Module Inventory — KEEP vs REMOVE

### ✅ KEEP (9 modules — inti gateway)

| Module    | Alasan                                                                                 |
| --------- | -------------------------------------------------------------------------------------- |
| `session` | **Core** — create, start, stop, QR code, status, reconnect                             |
| `message` | **Core** — send text, image, video, audio, document, location, contact, sticker, reply |
| `webhook` | **Core** — deliver event ke nawasena-backend (payload di-transform ke format Meta)     |
| `auth`    | **Security** — API key authentication (lindungi endpoint dari akses liar)              |
| `health`  | **Ops** — health check untuk monitoring                                                |
| `events`  | **Realtime** — WebSocket/Socket.IO untuk stream QR code ke frontend                    |
| `media`   | **Core** — handle media inbound (download dari WA) & outbound (upload)                 |
| `contact` | **Utility** — check number exists, get profile picture                                 |
| `group`   | **Utility** — basic group info (read-only, untuk tampil di chat list)                  |

### ❌ REMOVE (22 modules)

| Module         | Alasan hapus                                                 |
| -------------- | ------------------------------------------------------------ |
| `audit`        | nawasena punya audit sendiri                                 |
| `automation`   | nawasena punya autoreply sendiri                             |
| `call`         | Tidak dibutuhkan                                             |
| `catalog`      | nawasena pakai Meta Catalog API langsung                     |
| `channel`      | WhatsApp Channels/Newsletter — bukan fitur chat              |
| `chat-media`   | Duplikasi — nawasena punya media storage Supabase            |
| `docker`       | Built-in datastore orchestration — tidak diperlukan          |
| `infra`        | Config management UI — nawasena punya dashboard sendiri      |
| `integration`  | Plugin fabric — OpenWA INI SENDIRI adalah integrasi nawasena |
| `label`        | Tidak dibutuhkan                                             |
| `mcp`          | AI agent tools — tidak dibutuhkan                            |
| `metrics`      | Prometheus metrics — overkill untuk gateway lean             |
| `plugins`      | Plugin system — tidak dibutuhkan                             |
| `profile`      | Set profile name/photo — bisa ditambah nanti jika perlu      |
| `queue`        | BullMQ — webhook delivery cukup inline + simple retry        |
| `search`       | Full-text search — nawasena handle di Supabase               |
| `settings`     | Runtime settings UI — tidak diperlukan                       |
| `stats`        | Statistics — tidak dibutuhkan                                |
| `status`       | WhatsApp Status/Stories — bukan fitur chat                   |
| `status-store` | Status stories storage — bukan fitur chat                    |
| `takeover`     | Session takeover — tidak dibutuhkan                          |
| `template`     | Template management — nawasena pakai Meta Templates API      |

### 🔧 MODIFY (core & common)

| Component               | Perubahan                                                    |
| ----------------------- | ------------------------------------------------------------ |
| `src/core/plugins/`     | Strip plugin loader ke minimum (hanya load built-in engine)  |
| `src/core/hooks/`       | Hapus hook system (tidak ada plugins = tidak perlu hooks)    |
| `src/core/agent-tools/` | Hapus sepenuhnya (MCP tools)                                 |
| `src/common/cache/`     | Hapus (tidak pakai Redis)                                    |
| `src/common/storage/`   | Simplifikasi — hanya local filesystem                        |
| `src/common/throttler/` | Keep — rate limiting penting untuk keamanan                  |
| `src/config/`           | Simplifikasi env validation (hapus var yang tidak relevan)   |
| `dashboard/`            | **Hapus sepenuhnya** — nawasena punya UI sendiri             |
| `sdk/`                  | **Hapus sepenuhnya** — nawasena komunikasi langsung via REST |
| `app.module.ts`         | Strip imports ke hanya module yang di-KEEP                   |

---

## 4. Webhook Payload Transform — Kunci Integrasi

### Masalah

OpenWA mengirim webhook dalam format internal:

```json
{
  "event": "message.received",
  "timestamp": "2026-08-23T10:00:00.000Z",
  "sessionId": "uuid",
  "idempotencyKey": "...",
  "deliveryId": "...",
  "data": { "id": "...", "from": "628xxx@c.us", "body": "Hello", "type": "text" }
}
```

nawasena-backend (`webhookService.ts`) expects format Meta:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "628xxx",
              "phone_number_id": "SESSION_ID_AS_PHONE_ID"
            },
            "contacts": [
              {
                "profile": { "name": "John" },
                "wa_id": "628xxx"
              }
            ],
            "messages": [
              {
                "from": "628xxx",
                "id": "wamid.xxx",
                "timestamp": "1692789600",
                "type": "text",
                "text": { "body": "Hello" }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

### Solusi: Meta-Compatible Webhook Transformer

Buat service `MetaWebhookTransformer` di OpenWA yang mentransformasi **semua** event internal ke format Meta sebelum dikirim ke nawasena-backend. Transformasi terjadi di layer webhook, bukan di engine.

#### Event Mapping

| OpenWA Event       | Meta Webhook Field          | Keterangan                                             |
| ------------------ | --------------------------- | ------------------------------------------------------ |
| `message.received` | `value.messages[]`          | Pesan masuk — text, image, video, audio, doc           |
| `message.sent`     | `value.statuses[]` (sent)   | Pesan keluar berhasil terkirim                         |
| `message.ack`      | `value.statuses[]`          | delivered / read                                       |
| `message.failed`   | `value.statuses[]` (failed) | Pesan gagal                                            |
| `session.status`   | _(custom extension)_        | QR ready, connected, disconnected — extend Meta format |
| `session.qr`       | _(custom extension)_        | QR code data — tidak ada padanan Meta                  |

#### Transformasi Pesan Masuk (`message.received` → `value.messages[]`)

```typescript
// src/modules/webhook/meta-webhook-transformer.ts

interface MetaWebhookPayload {
  object: 'whatsapp_business_account';
  entry: [
    {
      id: string; // sessionId sebagai pseudo WABA ID
      changes: [
        {
          value: {
            messaging_product: 'whatsapp';
            metadata: {
              display_phone_number: string; // phone number session ini
              phone_number_id: string; // sessionId → nawasena match via channels.phone_number_id
            };
            contacts?: Array<{ profile: { name: string }; wa_id: string }>;
            messages?: Array<MetaMessage>;
            statuses?: Array<MetaStatus>;
          };
          field: 'messages';
        },
      ];
    },
  ];
}
```

#### Mapping Fields

| OpenWA field                | Meta field                                        |
| --------------------------- | ------------------------------------------------- |
| `data.from` (`628xxx@c.us`) | `messages[].from` = `628xxx` (strip `@c.us`)      |
| `data.id` (internal msg id) | `messages[].id` = `wamid.${data.id}`              |
| `data.body`                 | `messages[].text.body`                            |
| `data.type` = `image`       | `messages[].image.id` / `.caption` / `.mime_type` |
| `data.type` = `video`       | `messages[].video.id` / `.caption`                |
| `data.type` = `document`    | `messages[].document.id` / `.filename`            |
| `data.type` = `audio`       | `messages[].audio.id`                             |
| `data.timestamp` (epoch s)  | `messages[].timestamp`                            |
| `data.quotedMsg.id`         | `messages[].context.id`                           |

#### Media Handling

Media yang diterima OpenWA harus bisa diakses oleh nawasena-backend. Dua opsi:

1. **Opsi A (Recommended)**: OpenWA menyimpan media ke local disk, expose endpoint `GET /api/media/:id` yang mengembalikan file. nawasena-backend download dari sini (mirip Meta `getMediaUrl`).
2. **Opsi B**: Inline base64 di webhook payload — berat, tidak scalable.

Pilih **Opsi A**: media id di `messages[].image.id` = path file di OpenWA, nawasena-backend ambil via `GET /api/media/:id` (mirip panggil `graph.facebook.com/v21.0/:media_id`).

---

## 5. REST API yang Dipertahankan (untuk nawasena-backend)

nawasena-backend perlu memanggil OpenWA untuk:

### 5.1 Session Management

| Endpoint                        | Method | Fungsi                              |
| ------------------------------- | ------ | ----------------------------------- |
| `POST /api/sessions`            | POST   | Buat session baru                   |
| `POST /api/sessions/:id/start`  | POST   | Mulai session (generate QR)         |
| `GET  /api/sessions/:id/qr`     | GET    | Ambil QR code (base64)              |
| `GET  /api/sessions/:id`        | GET    | Status session (ready/qr_ready/etc) |
| `GET  /api/sessions`            | GET    | List semua session                  |
| `POST /api/sessions/:id/stop`   | POST   | Stop session                        |
| `DELETE /api/sessions/:id`      | DELETE | Hapus session                       |
| `POST /api/sessions/:id/logout` | POST   | Logout (perlu scan QR ulang)        |

### 5.2 Messaging (Outbound — nawasena kirim pesan)

| Endpoint                                        | Method | Fungsi        |
| ----------------------------------------------- | ------ | ------------- |
| `POST /api/sessions/:id/messages/send-text`     | POST   | Kirim teks    |
| `POST /api/sessions/:id/messages/send-image`    | POST   | Kirim gambar  |
| `POST /api/sessions/:id/messages/send-video`    | POST   | Kirim video   |
| `POST /api/sessions/:id/messages/send-audio`    | POST   | Kirim audio   |
| `POST /api/sessions/:id/messages/send-document` | POST   | Kirim dokumen |
| `POST /api/sessions/:id/messages/send-location` | POST   | Kirim lokasi  |
| `POST /api/sessions/:id/messages/send-contact`  | POST   | Kirim kontak  |

### 5.3 Media

| Endpoint             | Method | Fungsi                                              |
| -------------------- | ------ | --------------------------------------------------- |
| `GET /api/media/:id` | GET    | Download media (kompatibel Meta media URL approach) |

### 5.4 Utility

| Endpoint                                           | Method | Fungsi              |
| -------------------------------------------------- | ------ | ------------------- |
| `GET  /api/sessions/:id/contacts/check/:phone`     | GET    | Cek nomor ada di WA |
| `GET  /api/sessions/:id/contacts/:contactId/photo` | GET    | Ambil foto profil   |
| `GET  /api/health`                                 | GET    | Health check        |

### 5.5 Webhook Config

| Endpoint                                       | Method | Fungsi                         |
| ---------------------------------------------- | ------ | ------------------------------ |
| `POST   /api/sessions/:id/webhooks`            | POST   | Daftarkan webhook URL nawasena |
| `GET    /api/sessions/:id/webhooks`            | GET    | List webhooks                  |
| `DELETE /api/sessions/:id/webhooks/:webhookId` | DELETE | Hapus webhook                  |

---

## 6. Protokol Keamanan Anti-Ban (WAJIB)

### 6.1 Engine Selection

| Engine            | Ban Risk         | RAM per Session | Rekomendasi                                           |
| ----------------- | ---------------- | --------------- | ----------------------------------------------------- |
| `whatsapp-web.js` | **Rendah**       | ~300-500 MB     | **Default & recommended** — real Chromium fingerprint |
| `baileys`         | **Lebih tinggi** | ~30-80 MB       | Hanya jika resource sangat terbatas                   |

**Default: `ENGINE_TYPE=whatsapp-web.js`** — prioritas keamanan di atas efisiensi resource.

### 6.2 Puppeteer Stealth (wwebjs)

- **puppeteer-extra-plugin-stealth** sudah built-in di whatsapp-web.js
- Chromium args anti-detection:
  ```
  --no-sandbox
  --disable-setuid-sandbox
  --disable-web-security=false
  --disable-features=VizDisplayCompositor
  ```

### 6.3 Send Pacing (KRITIS)

Setiap pesan keluar HARUS di-delay untuk meniru perilaku manusia:

| Parameter                       | Default              | Env Var                 |
| ------------------------------- | -------------------- | ----------------------- |
| Delay minimum antar pesan       | 1500ms               | `SEND_DELAY_MIN_MS`     |
| Delay maximum antar pesan       | 3500ms               | `SEND_DELAY_MAX_MS`     |
| Randomize delay                 | true                 | `SEND_DELAY_RANDOMIZE`  |
| Max pesan per menit per session | 20                   | `SEND_RATE_PER_MINUTE`  |
| Typing indicator sebelum kirim  | true                 | `SEND_TYPING_INDICATOR` |
| Typing indicator durasi         | 1000-2500ms (random) | `TYPING_DURATION_MS`    |

Implementasi di `MessageService`:

```typescript
async sendWithPacing(sessionId: string, fn: () => Promise<MessageResult>): Promise<MessageResult> {
  // 1. Simulate typing indicator
  if (this.config.sendTypingIndicator) {
    await engine.sendPresenceUpdate(chatId, 'composing');
    await sleep(randomBetween(1000, 2500));
    await engine.sendPresenceUpdate(chatId, 'available');
  }
  // 2. Apply rate limit (token bucket per session)
  await this.rateLimiter.acquire(sessionId);
  // 3. Random delay
  await sleep(randomBetween(SEND_DELAY_MIN, SEND_DELAY_MAX));
  // 4. Send
  return fn();
}
```

### 6.4 Per-Session Proxy

Setiap session bisa dikonfigurasi dengan proxy sendiri untuk menghindari IP datacenter:

```json
{
  "name": "client-session",
  "proxyUrl": "socks5://user:pass@residential-proxy:1080",
  "proxyType": "socks5"
}
```

Tipe proxy yang didukung: `http`, `https`, `socks4`, `socks5`.

### 6.5 Reconnection Strategy

- **Reconnect otomatis** dengan exponential backoff (base 5s, max 5 menit)
- **Max reconnect attempts**: 10 (configurable per session)
- **Tidak reconnect agresif** — terlalu banyak reconnect = sinyal ban
- **Graceful disconnect** saat shutdown

### 6.6 Session Warm-Up Guidelines (Dokumentasi untuk Pengguna)

Nawasena dashboard harus menampilkan panduan:

1. Scan QR → tunggu 24-48 jam sebelum kirim pesan otomatis
2. Kirim beberapa pesan manual ke kontak yang sudah ada
3. Set foto profil dan nama
4. Jangan blast ke nomor yang belum pernah chat
5. Mulai dengan volume rendah (5-10 pesan/hari), naikkan bertahap

### 6.7 Anti-Ban Headers & Behavior

- **User-Agent**: Gunakan UA Chromium asli (tidak custom)
- **Jangan kirim pesan identik** berulang ke banyak nomor (nawasena harus variasi)
- **Mark as read** pesan masuk (sinyal akun aktif)
- **Auto-reject calls** opsional (tidak hang di call)

---

## 7. Alur Integrasi dengan nawasena-chat-backend

### 7.1 Setup Session (Scan QR)

```
Frontend                 nawasena-backend              OpenWA
   │                          │                          │
   │  POST /api/channels      │                          │
   │  {platform:"whatsapp_ow"}│                          │
   │─────────────────────────▶│                          │
   │                          │  POST /api/sessions      │
   │                          │  {name:"tenant-xxx"}     │
   │                          │─────────────────────────▶│
   │                          │  ◀──── {id, status}      │
   │                          │                          │
   │                          │  POST /sessions/:id/start│
   │                          │─────────────────────────▶│
   │                          │                          │
   │                          │  POST /sessions/:id/webhooks
   │                          │  {url:"https://nawasena/webhook/openwa"}
   │                          │─────────────────────────▶│
   │                          │                          │
   │  WebSocket: qr_code      │  GET /sessions/:id/qr   │
   │◀──────────────────────────│─────────────────────────▶│
   │                          │                          │
   │  [User scans QR]         │                          │
   │                          │  Webhook: session.status │
   │                          │◀─────────────────────────│
   │  WebSocket: connected    │                          │
   │◀─────────────────────────│                          │
```

### 7.2 Terima Pesan Masuk

```
WhatsApp         OpenWA                    nawasena-backend
   │               │                            │
   │  New message  │                            │
   │──────────────▶│                            │
   │               │  Transform ke Meta format  │
   │               │  POST webhook              │
   │               │  (identik Meta payload)    │
   │               │───────────────────────────▶│
   │               │                            │  handleMetaWebhookPayload(body)
   │               │                            │  → resolve tenant via phone_number_id
   │               │                            │  → upsert session
   │               │                            │  → insert message
   │               │                            │  → WebSocket broadcast
   │               │                            │
```

### 7.3 Kirim Pesan Keluar

```
Frontend              nawasena-backend              OpenWA
   │                       │                          │
   │  POST /api/send       │                          │
   │  {type:"text",...}    │                          │
   │──────────────────────▶│                          │
   │                       │  (detect platform =      │
   │                       │   whatsapp_openwa)       │
   │                       │                          │
   │                       │  POST /api/sessions/:id/ │
   │                       │  messages/send-text      │
   │                       │  {chatId, text}          │
   │                       │─────────────────────────▶│
   │                       │  ◀── {messageId}         │
   │                       │                          │
   │                       │  (simpan ke DB,          │
   │                       │   broadcast WS)          │
   │  WebSocket: new_msg   │                          │
   │◀──────────────────────│                          │
   │                       │                          │
   │                       │  Webhook: status=sent    │
   │                       │◀─────────────────────────│
   │                       │  (update message status) │
```

---

## 8. Perubahan di nawasena-chat-backend (Konteks)

> Ini BUKAN file OpenWA — ini dokumentasi apa yang perlu berubah di nawasena-backend untuk integrasi.

### 8.1 Tabel `channels` — tambah platform baru

```sql
-- Platform baru: 'whatsapp_openwa'
-- phone_number_id → OpenWA session ID (untuk routing webhook)
-- access_token → OpenWA API key
-- waba_id → null (tidak relevan)
-- Kolom tambahan:
--   openwa_base_url → 'http://openwa:2785/api'
--   openwa_session_id → UUID session di OpenWA
```

### 8.2 Route `webhook.ts` — endpoint baru untuk OpenWA

```
POST /webhook/openwa  ← OpenWA kirim payload format Meta ke sini
```

Karena payload sudah identik dengan Meta, handler bisa reuse `handleMetaWebhookPayload(body)` langsung.

### 8.3 Route `send.ts` — dispatcher tambahan

```typescript
if (channel.platform === 'whatsapp_openwa') {
  // Kirim via OpenWA REST API
  const result = await sendViaOpenWA(channel, chatId, messagePayload);
} else {
  // Kirim via Meta Graph API (existing)
  const result = await sendWhatsAppText(channel, chatId, text);
}
```

---

## 9. Environment Variables (OpenWA Nawasena Edition)

### Wajib

| Var             | Default           | Keterangan      |
| --------------- | ----------------- | --------------- |
| `PORT`          | `2785`            | Port API        |
| `ENGINE_TYPE`   | `whatsapp-web.js` | Engine WhatsApp |
| `DATABASE_TYPE` | `sqlite`          | Selalu SQLite   |
| `NODE_ENV`      | `production`      | —               |

### Security & Pacing

| Var                       | Default  | Keterangan                           |
| ------------------------- | -------- | ------------------------------------ |
| `ALLOW_DEV_API_KEY`       | `false`  | Hanya `true` di development          |
| `API_KEY_PEPPER`          | _(set!)_ | Pepper untuk hash API key            |
| `SEND_DELAY_MIN_MS`       | `1500`   | Min delay antar pesan (ms)           |
| `SEND_DELAY_MAX_MS`       | `3500`   | Max delay antar pesan (ms)           |
| `SEND_RATE_PER_MINUTE`    | `20`     | Max pesan per menit per session      |
| `SEND_TYPING_INDICATOR`   | `true`   | Kirim typing indicator sebelum pesan |
| `MAX_CONCURRENT_SESSIONS` | `5`      | Batasi jumlah session                |

### Rate Limiting

| Var                       | Default | Keterangan             |
| ------------------------- | ------- | ---------------------- |
| `RATE_LIMIT_SHORT_TTL`    | `1000`  | Window 1 detik (ms)    |
| `RATE_LIMIT_SHORT_LIMIT`  | `10`    | Max request per window |
| `RATE_LIMIT_MEDIUM_TTL`   | `60000` | Window 1 menit (ms)    |
| `RATE_LIMIT_MEDIUM_LIMIT` | `100`   | Max request per window |

---

## 10. Struktur Direktori Target (Setelah Strip)

```
OpenWA/
├── src/
│   ├── main.ts                     # Entry point (simplified)
│   ├── app.module.ts               # Root module (stripped to 9 modules)
│   ├── configure-app.ts            # Helmet, CORS, security headers
│   │
│   ├── common/
│   │   ├── errors/                 # Error classes
│   │   ├── interceptors/           # KEEP
│   │   ├── media/                  # Media utils
│   │   ├── middleware/             # KEEP
│   │   ├── security/               # KEEP
│   │   ├── services/               # Logger
│   │   ├── throttler/              # KEEP (rate limiting)
│   │   ├── transformers/           # Date transformer
│   │   └── utils/                  # IP utils, etc.
│   │   # REMOVED: cache/, storage/ (S3), metrics/
│   │
│   ├── config/                     # Simplified config
│   │
│   ├── engine/                     # KEEP FULLY — core WhatsApp engine
│   │   ├── engine.module.ts
│   │   ├── engine.factory.ts
│   │   ├── engine-registry.service.ts
│   │   ├── adapters/               # wwebjs + baileys adapters
│   │   ├── builtin/                # Built-in engine plugins
│   │   ├── identity/               # WhatsApp ID normalization
│   │   ├── interfaces/             # IWhatsAppEngine
│   │   └── types/
│   │
│   ├── modules/
│   │   ├── session/                # ✅ KEEP
│   │   ├── message/                # ✅ KEEP
│   │   ├── webhook/                # ✅ KEEP + MetaWebhookTransformer (NEW)
│   │   ├── auth/                   # ✅ KEEP
│   │   ├── health/                 # ✅ KEEP
│   │   ├── events/                 # ✅ KEEP (WebSocket for QR)
│   │   ├── media/                  # ✅ KEEP
│   │   ├── contact/                # ✅ KEEP
│   │   └── group/                  # ✅ KEEP
│   │   # REMOVED: 22 other modules
│   │
│   └── database/
│       ├── data-source.ts
│       ├── data-source-main.ts
│       ├── migrations/             # Keep relevant migrations only
│       └── migrations-main/
│
├── data/                           # Runtime data (sessions, media)
├── Dockerfile                      # Simplified
├── docker-compose.yml              # Just OpenWA (no Postgres/Redis/MinIO)
├── package.json                    # Stripped dependencies
└── docs/                           # Trimmed docs
```

---

## 11. File Baru yang Perlu Dibuat

### 11.1 `src/modules/webhook/meta-webhook-transformer.ts`

Service utama yang mentransformasi event internal OpenWA ke format Meta webhook payload.

**Methods:**

- `transformMessageReceived(event) → MetaWebhookPayload`
- `transformMessageStatus(event) → MetaWebhookPayload`
- `transformSessionEvent(event) → MetaWebhookPayload` (custom extension)
- `stripWaIdSuffix(jid: string) → string` — `628xxx@c.us` → `628xxx`
- `toWamid(internalId: string) → string` — prefix `wamid.` agar konsisten
- `toEpochSeconds(isoTimestamp: string) → string`

### 11.2 `src/modules/media/media-download.controller.ts`

Endpoint `GET /api/media/:id` untuk nawasena-backend download media inbound. Mirip Meta `GET /{media-id}` yang return URL, lalu `GET url` yang return binary.

---

## 12. Urutan Implementasi

### Phase 1: Strip & Cleanup

1. [ ] Hapus 22 module dari `src/modules/`
2. [ ] Hapus `dashboard/`, `sdk/`, `charts/`
3. [ ] Strip `app.module.ts` — hanya import 9 modules
4. [ ] Strip `src/core/` — hapus plugin hooks, agent-tools
5. [ ] Strip `src/common/` — hapus cache, S3 storage
6. [ ] Simplifikasi `package.json` — hapus dependencies yang tidak dipakai
7. [ ] Simplifikasi `docker-compose.yml` — hanya OpenWA container
8. [ ] Update `.env.example` — hanya var yang relevan
9. [ ] Verifikasi: `npm run build` harus berhasil tanpa error

### Phase 2: Meta Webhook Transformer

1. [ ] Buat `MetaWebhookTransformer` service
2. [ ] Integrasikan di webhook delivery pipeline
3. [ ] Transform `message.received` → Meta messages format
4. [ ] Transform `message.ack` → Meta statuses format
5. [ ] Transform `message.sent` → Meta statuses format
6. [ ] Transform media messages (image/video/audio/doc)
7. [ ] Handle reply context (`context.id`)
8. [ ] Handle group messages
9. [ ] Unit test: snapshot test payload output vs Meta format

### Phase 3: Send Pacing & Security

1. [ ] Implement send pacing (delay, rate limit, typing indicator)
2. [ ] Implement per-session proxy configuration
3. [ ] Configure reconnection strategy
4. [ ] Configure Puppeteer stealth args
5. [ ] Test: send 50 pesan dengan pacing, verifikasi delay

### Phase 4: Media Endpoint

1. [ ] Buat `GET /api/media/:id` endpoint
2. [ ] Media download dari inbound messages disimpan ke `data/media/`
3. [ ] Return media binary dengan proper content-type
4. [ ] Test: terima media dari WA, download via endpoint

### Phase 5: Integration Test dengan nawasena-backend

1. [ ] nawasena-backend: tambah `POST /webhook/openwa` route
2. [ ] nawasena-backend: tambah OpenWA send adapter di `send.ts`
3. [ ] nawasena-backend: channel CRUD untuk `whatsapp_openwa`
4. [ ] End-to-end: scan QR → terima pesan → kirim pesan → status update
5. [ ] Frontend: QR scanner component di nawasena-chat

---

## 13. Konvensi & Aturan

1. **Engine layer tidak boleh diubah** — ini adalah jantung OpenWA, adapters sudah mature dan teruji.
2. **Webhook payload = Meta format** — jangan pernah kirim format internal ke nawasena.
3. **Selalu gunakan pacing** saat kirim pesan — tidak ada jalan pintas.
4. **API key wajib** — tidak ada unauthenticated endpoint (kecuali health).
5. **SQLite only** — jangan tambahkan PostgreSQL/Redis complexity.
6. **Tidak ada test suite otomatis saat ini** — verifikasi via build + manual test.
7. **Jangan merge kembali ke upstream OpenWA** — ini adalah fork khusus nawasena.
