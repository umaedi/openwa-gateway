# OpenWA Gateway - WhatsApp Unofficial Broadcast Specification

This document details the architecture, anti-ban pacing, message dispatch flow, and status acknowledgment webhooks for the **Unofficial WhatsApp Broadcast Engine** connecting Nawasena Chat Backend to OpenWA Gateway.

---

## 1. Architecture Overview

```
Frontend (React) -> Backend (Hono) -> BullMQ (Redis) -> Broadcast Worker -> OpenWA Gateway -> WA Network
                                                                              │
                                       Backend Webhook (ACKs) ◄───────────────┘
```

---

## 2. Key Rules & Specifications

### A. Anti-Ban Pacing & Quota Rules
- **Tenant Rolling Limit**: Maximum **100 contacts per 24 hours** per tenant.
- **Batch Campaign Limit**: Maximum **100 recipients** per campaign creation.
- **Random Delay Pacing**: 60 to 120 seconds interval between outbound messages per device.

### B. Outbound Endpoints Used
- Text Message: `POST /api/sessions/:sessionId/messages/send-text`
- Image Message: `POST /api/sessions/:sessionId/messages/send-image`
- Document Message: `POST /api/sessions/:sessionId/messages/send-document`

### C. Inbound Status Webhooks
- Webhook Target: `POST /webhook/openwa/messages`
- Event: `message.ack`
- Status Mapping:
  - ACK 1: `sent`
  - ACK 2: `delivered`
  - ACK 3: `read`
  - ACK -1: `failed`
