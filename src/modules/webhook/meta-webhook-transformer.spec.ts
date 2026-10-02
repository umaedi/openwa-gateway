import { MetaWebhookTransformer } from './meta-webhook-transformer';

describe('MetaWebhookTransformer', () => {
  it('should transform inbound image message with mediaPath deterministically', () => {
    const sessionId = 'session-uuid-123';
    const event = 'message.received';
    const data = {
      id: 'false_628123456789@c.us_3EB0ABCDEF123456',
      from: '628123456789@c.us',
      to: '6285741492045@c.us',
      type: 'image',
      timestamp: 1788567399,
      caption: 'Foto bukti',
      mimetype: 'image/jpeg',
      mediaPath: 'media/session-uuid-123/2026/09/1788567399970-05c4491cd0f7f944-file.jpg',
      mediaUrl: 'https://r2.cloudflarestorage.com/nawasena-chat/media/session-uuid-123/2026/09/1788567399970-05c4491cd0f7f944-file.jpg',
    };

    const payload = MetaWebhookTransformer.transform(sessionId, event, data);

    expect(payload.object).toBe('whatsapp_business_account');
    const change = payload.entry[0].changes[0].value;
    expect(change.metadata.platform).toBe('whatsapp_unofficial');
    expect(change.metadata.phone_number_id).toBe(sessionId);

    const message = change.messages![0];
    expect(message.id).toBe('wamid.false_628123456789@c.us_3EB0ABCDEF123456');
    expect(message.type).toBe('image');
    expect(message.image).toBeDefined();
    expect(message.image?.id).toBe('wamid.false_628123456789@c.us_3EB0ABCDEF123456');
    expect(message.image?.media_path).toBe('media/session-uuid-123/2026/09/1788567399970-05c4491cd0f7f944-file.jpg');
    expect(message.image?.link).toBe('https://r2.cloudflarestorage.com/nawasena-chat/media/session-uuid-123/2026/09/1788567399970-05c4491cd0f7f944-file.jpg');
  });

  it('should set media_path and link to undefined when mediaPath is missing', () => {
    const sessionId = 'session-uuid-123';
    const event = 'message.received';
    const data = {
      id: 'false_628123456789@c.us_3EB0ABCDEF123456',
      from: '628123456789@c.us',
      to: '6285741492045@c.us',
      type: 'image',
      timestamp: 1788567399,
      caption: 'Foto tanpa media',
      mimetype: 'image/jpeg',
    };

    const payload = MetaWebhookTransformer.transform(sessionId, event, data);
    const message = payload.entry[0].changes[0].value.messages![0];
    expect(message.image?.id).toBe('wamid.false_628123456789@c.us_3EB0ABCDEF123456');
    expect(message.image?.media_path).toBeUndefined();
    expect(message.image?.link).toBeUndefined();
  });
});
