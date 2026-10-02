export interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'contacts' | 'interactive' | string;
  text?: {
    body: string;
  };
  image?: {
    id: string;
    caption?: string;
    mime_type?: string;
    sha256?: string;
    media_path?: string;
    link?: string;
  };
  video?: {
    id: string;
    caption?: string;
    mime_type?: string;
    sha256?: string;
    media_path?: string;
    link?: string;
  };
  audio?: {
    id: string;
    mime_type?: string;
    voice?: boolean;
    media_path?: string;
    link?: string;
  };
  document?: {
    id: string;
    filename?: string;
    caption?: string;
    mime_type?: string;
    media_path?: string;
    link?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  contacts?: Array<{
    name: { formatted_name: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone: string; type?: string }>;
  }>;
  interactive?: Record<string, unknown>;
  context?: {
    id?: string;
    from?: string;
  };
}

export interface MetaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id?: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

export interface MetaWebhookPayload {
  object: 'whatsapp_business_account';
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: 'whatsapp';
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
          platform?: string;
        };
        contacts?: Array<{
          profile: {
            name: string;
          };
          wa_id: string;
          external_id?: string;
          from_jid?: string;
        }>;
        messages?: MetaMessage[];
        statuses?: MetaStatus[];
        session_event?: {
          event: string;
          status?: string;
          qr?: string;
          reason?: string;
          me?: {
            id?: string;
            pushName?: string;
          };
        };
      };
      field: 'messages';
    }>;
  }>;
}

export class MetaWebhookTransformer {
  /**
   * Normalize WhatsApp JID to plain phone number (strip @c.us, @s.whatsapp.net, @g.us)
   */
  static cleanWaId(jid?: string | null): string {
    if (!jid) return '';
    return jid.replace(/@(c\.us|s\.whatsapp\.net|g\.us|lid)$/, '');
  }

  /**
   * Ensure wamid. prefix for message IDs
   */
  static toWamid(msgId?: string | null): string {
    if (!msgId) return '';
    return msgId.startsWith('wamid.') ? msgId : `wamid.${msgId}`;
  }

  /**
   * Convert timestamp to Unix epoch in seconds as string
   */
  static toEpochSeconds(ts?: string | number | Date | null): string {
    if (!ts) return Math.floor(Date.now() / 1000).toString();
    if (typeof ts === 'number') {
      // If already in seconds (10 digits), keep it. If in ms (13 digits), divide by 1000.
      return ts > 10000000000 ? Math.floor(ts / 1000).toString() : Math.floor(ts).toString();
    }
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      if (!isNaN(parsed)) return Math.floor(parsed / 1000).toString();
      const num = parseInt(ts, 10);
      if (!isNaN(num)) return num > 10000000000 ? Math.floor(num / 1000).toString() : num.toString();
    }
    if (ts instanceof Date) {
      return Math.floor(ts.getTime() / 1000).toString();
    }
    return Math.floor(Date.now() / 1000).toString();
  }

  /**
   * Transform internal OpenWA message/status event to standard Meta WhatsApp Cloud Webhook format.
   */
  static transform(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
  ): MetaWebhookPayload {
    const phoneId = sessionId;
    const displayPhone = typeof data.displayPhone === 'string' ? data.displayPhone : '';

    const entryChangesValue: MetaWebhookPayload['entry'][0]['changes'][0]['value'] = {
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: displayPhone,
        phone_number_id: phoneId,
        platform: 'whatsapp_unofficial',
      },
    };

    if (event === 'message.received') {
      const fromJid = (data.from as string) || (data.author as string) || '';
      const contactObj = (data.contact as Record<string, unknown>) || {};
      const resolvedNumber = (contactObj.number as string) || (data.phone as string) || '';
      const from = resolvedNumber ? this.cleanWaId(resolvedNumber) : this.cleanWaId(fromJid);
      const pushName = (contactObj.pushName as string) || (contactObj.name as string) || (data.pushName as string) || (data.notifyName as string) || (data.chatName as string) || from;
      const rawId = (data.id as string) || (data.waMessageId as string) || '';
      const wamid = this.toWamid(rawId);
      const timestamp = this.toEpochSeconds(data.timestamp as string | number);
      const type = (data.type as string) || 'text';

      entryChangesValue.contacts = [
        {
          profile: { name: pushName },
          wa_id: from,
          external_id: fromJid,
          from_jid: fromJid,
        },
      ];

      const metaMsg: MetaMessage & { external_id?: string; from_jid?: string } = {
        from,
        id: wamid,
        timestamp,
        type,
        external_id: fromJid,
        from_jid: fromJid,
      };

      if (type === 'text') {
        metaMsg.text = { body: (data.body as string) || '' };
      } else if (type === 'image') {
        const mediaPath = typeof data.mediaPath === 'string' && data.mediaPath ? data.mediaPath : undefined;
        const mediaLink = (data.mediaUrl as string) || (mediaPath ? `/media/stream/${mediaPath}` : undefined);
        metaMsg.image = {
          id: wamid,
          caption: (data.caption as string) || undefined,
          mime_type: (data.mimetype as string) || (data.mimeType as string) || 'image/jpeg',
          media_path: mediaPath,
          link: mediaLink,
        };
      } else if (type === 'video') {
        const mediaPath = typeof data.mediaPath === 'string' && data.mediaPath ? data.mediaPath : undefined;
        const mediaLink = (data.mediaUrl as string) || (mediaPath ? `/media/stream/${mediaPath}` : undefined);
        metaMsg.video = {
          id: wamid,
          caption: (data.caption as string) || undefined,
          mime_type: (data.mimetype as string) || (data.mimeType as string) || 'video/mp4',
          media_path: mediaPath,
          link: mediaLink,
        };
      } else if (type === 'audio' || type === 'ptt' || type === 'voice') {
        const mediaPath = typeof data.mediaPath === 'string' && data.mediaPath ? data.mediaPath : undefined;
        const mediaLink = (data.mediaUrl as string) || (mediaPath ? `/media/stream/${mediaPath}` : undefined);
        metaMsg.type = 'audio';
        metaMsg.audio = {
          id: wamid,
          mime_type: (data.mimetype as string) || (data.mimeType as string) || 'audio/ogg',
          voice: type === 'ptt' || type === 'voice',
          media_path: mediaPath,
          link: mediaLink,
        };
      } else if (type === 'document') {
        const mediaPath = typeof data.mediaPath === 'string' && data.mediaPath ? data.mediaPath : undefined;
        const mediaLink = (data.mediaUrl as string) || (mediaPath ? `/media/stream/${mediaPath}` : undefined);
        metaMsg.document = {
          id: wamid,
          filename: (data.filename as string) || 'document',
          caption: (data.caption as string) || undefined,
          mime_type: (data.mimetype as string) || (data.mimeType as string) || 'application/octet-stream',
          media_path: mediaPath,
          link: mediaLink,
        };
      } else if (type === 'location') {
        metaMsg.location = {
          latitude: (data.latitude as number) || 0,
          longitude: (data.longitude as number) || 0,
          name: (data.name as string) || undefined,
          address: (data.address as string) || undefined,
        };
      } else {
        metaMsg.text = { body: (data.body as string) || '' };
      }

      if (data.quotedMsg || data.contextInfo) {
        const q = (data.quotedMsg || data.contextInfo) as Record<string, unknown>;
        const qId = (q.id || q.stanzaId) as string | undefined;
        if (qId) {
          metaMsg.context = {
            id: this.toWamid(qId),
            from: this.cleanWaId(q.participant as string | undefined),
          };
        }
      }

      entryChangesValue.messages = [metaMsg];
    } else if (event === 'message.ack' || event === 'message.sent' || event === 'message.failed') {
      const rawId = (data.messageId as string) || (data.id as string) || (data.waMessageId as string) || '';
      const wamid = this.toWamid(rawId);
      const timestamp = this.toEpochSeconds(data.timestamp as string | number);
      const recipient = this.cleanWaId((data.to as string) || (data.recipient as string) || '');

      let statusType: MetaStatus['status'] = 'sent';
      if (event === 'message.sent') statusType = 'sent';
      else if (event === 'message.failed' || data.status === 'failed') statusType = 'failed';
      else if (data.status === 'read' || data.ack === 3 || data.ack === 4) statusType = 'read';
      else if (data.status === 'delivered' || data.ack === 2) statusType = 'delivered';
      else statusType = 'sent';

      const metaStatus: MetaStatus = {
        id: wamid,
        status: statusType,
        timestamp,
        recipient_id: recipient || undefined,
      };

      if (event === 'message.failed' || data.error) {
        metaStatus.errors = [
          {
            code: 100,
            title: 'Message delivery failed',
            message: typeof data.error === 'string' ? data.error : 'Unknown delivery failure',
          },
        ];
      }

      entryChangesValue.statuses = [metaStatus];
    } else {
      // Extended event for session status/qr/etc
      const meData = (data.me as { id?: string; pushName?: string } | undefined) ||
        (data.phone ? { id: data.phone as string, pushName: data.pushName as string } : undefined);

      entryChangesValue.session_event = {
        event,
        status: data.status as string | undefined,
        qr: data.qr as string | undefined,
        reason: data.reason as string | undefined,
        me: meData,
      };
    }

    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: phoneId,
          changes: [
            {
              value: entryChangesValue,
              field: 'messages',
            },
          ],
        },
      ],
    };
  }
}
