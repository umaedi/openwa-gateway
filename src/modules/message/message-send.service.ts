import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import {
  SendTextMessageDto,
  SendMediaMessageDto,
  SendAudioMessageDto,
  MessageResponseDto,
} from './dto';
import {
  SendLocationDto,
  SendContactDto,
  SendPollDto,
  ReplyMessageDto,
  ForwardMessageDto,
  ReactMessageDto,
  DeleteMessageDto,
  EditMessageDto,
} from './dto/message-actions.dto';
import { assertBase64WithinMediaCap, stripBase64DataUri } from './media-cap.util';
import {
  MediaInput,
  IWhatsAppEngine,
  MessageResult,
  LocationInput,
  ContactCard,
  PollInput,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SendPacingService, countsTowardSendBreaker } from './send-pacing.service';
import { createLogger } from '../../common/services/logger.service';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { isUniqueViolation } from '../../common/utils/db-errors';

export const DEFAULT_TEMPLATE_RENDER_MAX_CHARS = 64 * 1024;

export interface SaveOutgoingMessageData {
  waMessageId?: string;
  chatId: string;
  body?: string;
  type: string;
  timestamp?: number;
  status?: MessageStatus;
  metadata?: Record<string, unknown>;
  quotedMessageId?: string;
}

@Injectable()
export class MessageSendService {
  private readonly logger = createLogger('MessageSend');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly engines: EngineRegistry,
    private readonly pacing: SendPacingService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    if (dto.linkPreview === false && dto.customLinkPreview) {
      throw new BadRequestException('linkPreview: false cannot be combined with customLinkPreview');
    }
    const finalDto = await this.applySendingGate(sessionId, 'text', dto);
    const engine = this.getEngine(sessionId);

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
      quotedMessageId: finalDto.quotedMessageId,
    });

    let result!: MessageResult;
    try {
      result = await engine.sendTextMessage(
        finalDto.chatId,
        finalDto.text,
        finalDto.mentions,
        {
          quotedMessageId: finalDto.quotedMessageId,
          linkPreview: finalDto.linkPreview,
          customPreview: finalDto.customLinkPreview,
        },
      );
    } catch (error) {
      await this.failSend(sessionId, 'text', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sendGenericMedia(sessionId, 'image', dto, input => this.getEngine(sessionId).sendImageMessage(dto.chatId, input));
  }

  async sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sendGenericMedia(sessionId, 'video', dto, input => this.getEngine(sessionId).sendVideoMessage(dto.chatId, input));
  }

  async sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    this.assertMediaPayloadProvided(dto);
    assertBase64WithinMediaCap(dto.base64);

    const finalDto = await this.applySendingGate(sessionId, 'audio', dto);
    const engine = this.getEngine(sessionId);

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: '',
      type: finalDto.ptt ? 'voice' : 'audio',
      metadata: {
        media: {
          mimetype: finalDto.mimetype || (finalDto.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp3'),
          data: finalDto.base64 || finalDto.url,
        },
      },
      quotedMessageId: finalDto.quotedMessageId,
    });

    const mediaInput: MediaInput = {
      mimetype: finalDto.mimetype || (finalDto.ptt ? 'audio/ogg; codecs=opus' : 'audio/mp3'),
      data: (finalDto.base64 ? stripBase64DataUri(finalDto.base64) : finalDto.url) || '',
      ptt: finalDto.ptt,
      quotedMessageId: finalDto.quotedMessageId,
      caption: finalDto.caption,
      mentions: finalDto.mentions,
    };

    let result!: MessageResult;
    try {
      result = await engine.sendAudioMessage(finalDto.chatId, mediaInput);
    } catch (error) {
      await this.failSend(sessionId, 'audio', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sendGenericMedia(sessionId, 'document', dto, input => this.getEngine(sessionId).sendDocumentMessage(dto.chatId, input));
  }

  async sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sendGenericMedia(sessionId, 'sticker', dto, input => this.getEngine(sessionId).sendStickerMessage(dto.chatId, input));
  }

  private async sendGenericMedia(
    sessionId: string,
    type: 'image' | 'video' | 'document' | 'sticker',
    dto: SendMediaMessageDto,
    sender: (input: MediaInput) => Promise<MessageResult>,
  ): Promise<MessageResponseDto> {
    this.assertMediaPayloadProvided(dto);
    assertBase64WithinMediaCap(dto.base64);

    const finalDto = await this.applySendingGate(sessionId, type, dto);
    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.caption,
      type,
      metadata: {
        media: {
          mimetype: finalDto.mimetype,
          filename: finalDto.filename,
          data: finalDto.base64 || finalDto.url,
        },
      },
      quotedMessageId: finalDto.quotedMessageId,
    });

    const mediaInput: MediaInput = {
      mimetype: finalDto.mimetype || 'application/octet-stream',
      data: (finalDto.base64 ? stripBase64DataUri(finalDto.base64) : finalDto.url) || '',
      filename: finalDto.filename,
      caption: finalDto.caption,
      mentions: finalDto.mentions,
      quotedMessageId: finalDto.quotedMessageId,
    };

    let result!: MessageResult;
    try {
      result = await sender(mediaInput);
    } catch (error) {
      await this.failSend(sessionId, type, message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async sendLocation(sessionId: string, dto: SendLocationDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'location', dto);
    const engine = this.getEngine(sessionId);

    const locationInput: LocationInput = {
      latitude: finalDto.latitude,
      longitude: finalDto.longitude,
      description: finalDto.description,
      quotedMessageId: finalDto.quotedMessageId,
    };

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.description,
      type: 'location',
      metadata: { location: locationInput },
      quotedMessageId: finalDto.quotedMessageId,
    });

    let result!: MessageResult;
    try {
      result = await engine.sendLocationMessage(finalDto.chatId, locationInput);
    } catch (error) {
      await this.failSend(sessionId, 'location', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async sendContact(sessionId: string, dto: SendContactDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'contact', dto);
    const engine = this.getEngine(sessionId);

    const contactCard: ContactCard = {
      name: finalDto.contactName,
      number: finalDto.contactNumber,
      quotedMessageId: finalDto.quotedMessageId,
    };

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.contactName,
      type: 'contact',
      metadata: { contact: contactCard },
      quotedMessageId: finalDto.quotedMessageId,
    });

    let result!: MessageResult;
    try {
      result = await engine.sendContactMessage(finalDto.chatId, contactCard);
    } catch (error) {
      await this.failSend(sessionId, 'contact', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async sendPoll(sessionId: string, dto: SendPollDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'poll', dto);
    const engine = this.getEngine(sessionId);

    const pollInput: PollInput = {
      name: finalDto.name,
      options: finalDto.options,
      allowMultipleAnswers: finalDto.allowMultipleAnswers,
      quotedMessageId: finalDto.quotedMessageId,
    };

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.name,
      type: 'poll',
      metadata: { poll: pollInput },
      quotedMessageId: finalDto.quotedMessageId,
    });

    let result!: MessageResult;
    try {
      result = await engine.sendPollMessage(finalDto.chatId, pollInput);
    } catch (error) {
      await this.failSend(sessionId, 'poll', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async reply(sessionId: string, dto: ReplyMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'reply', dto);
    const engine = this.getEngine(sessionId);

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.chatId,
      body: finalDto.text,
      type: 'text',
      quotedMessageId: finalDto.quotedMessageId,
    });

    let result!: MessageResult;
    try {
      result = await engine.replyToMessage(finalDto.chatId, finalDto.quotedMessageId, finalDto.text, finalDto.mentions);
    } catch (error) {
      await this.failSend(sessionId, 'reply', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async forward(sessionId: string, dto: ForwardMessageDto): Promise<MessageResponseDto> {
    const finalDto = await this.applySendingGate(sessionId, 'forward', dto);
    const engine = this.getEngine(sessionId);

    const message = await this.saveOutgoingMessage(sessionId, {
      chatId: finalDto.toChatId,
      type: 'forward',
    });

    let result!: MessageResult;
    try {
      result = await engine.forwardMessage(finalDto.fromChatId, finalDto.toChatId, finalDto.messageId);
    } catch (error) {
      await this.failSend(sessionId, 'forward', message, finalDto, error);
    }

    return this.persistSentState(message, result);
  }

  async react(sessionId: string, dto: ReactMessageDto): Promise<void> {
    this.assertDirectChatRecipient(dto.chatId);
    await this.pacing.assertSendAllowed(sessionId, dto.chatId);
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async delete(sessionId: string, dto: DeleteMessageDto): Promise<void> {
    this.assertDirectChatRecipient(dto.chatId);
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);
  }

  async edit(sessionId: string, dto: EditMessageDto): Promise<void> {
    this.assertDirectChatRecipient(dto.chatId);
    await this.pacing.assertSendAllowed(sessionId, dto.chatId);
    const engine = this.getEngine(sessionId);
    await engine.editMessage(dto.chatId, dto.messageId, dto.body, dto.mentions);
  }

  private assertDirectChatRecipient(recipient: string): void {
    if (
      recipient.endsWith('@g.us') ||
      recipient.endsWith('@newsletter') ||
      recipient.endsWith('@broadcast') ||
      recipient.includes('@broadcast')
    ) {
      throw new BadRequestException(
        'Sending messages to groups, newsletters, or broadcast channels is not supported. Only 1:1 direct chats are allowed.',
      );
    }
  }

  private async applySendingGate<T>(sessionId: string, _type: string, input: T): Promise<T> {
    const target = input as { chatId?: string; toChatId?: string };
    const dest = target.chatId ?? target.toChatId;
    if (dest) {
      this.assertDirectChatRecipient(dest);
    }
    await this.pacing.assertSendAllowed(sessionId, dest);
    return input;
  }

  private async failSend(
    sessionId: string,
    _type: string,
    message: Message,
    _input: unknown,
    error: unknown,
  ): Promise<never> {
    if (countsTowardSendBreaker(error)) {
      this.pacing.recordSendFailure(sessionId);
    }
    await this.saveFailedMessage(message);
    throw this.toClientFacingError(error);
  }

  private toClientFacingError(error: unknown): Error {
    if (error instanceof SsrfBlockedError) {
      return new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }

  private assertMediaPayloadProvided(dto: SendMediaMessageDto): void {
    if (!dto.url && !dto.base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }
  }

  private async saveFailedMessage(message: Message): Promise<void> {
    const media = (message.metadata as { media?: { data?: unknown } } | undefined)?.media;
    if (media) {
      delete media.data;
    }
    message.status = MessageStatus.FAILED;
    await this.messageRepository.save(message);
  }

  private async persistSentState(
    message: Message,
    result: MessageResult,
  ): Promise<MessageResponseDto> {
    this.pacing.recordSendSuccess(message.sessionId);

    message.waMessageId = result.id;
    message.status = MessageStatus.SENT;
    message.timestamp = result.timestamp;

    try {
      await this.messageRepository.save(message);
    } catch (persistError) {
      if (isUniqueViolation(persistError)) {
        await this.messageRepository.delete({ id: message.id }).catch(() => undefined);
      } else {
        this.logger.warn(`Persisting SENT state failed after a successful send (id=${result.id})`, {
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
    }
    return { messageId: result.id, timestamp: result.timestamp };
  }

  async saveOutgoingMessage(sessionId: string, data: SaveOutgoingMessageData): Promise<Message> {
    const message = this.messageRepository.create({
      sessionId,
      chatId: data.chatId,
      from: sessionId,
      to: data.chatId,
      body: data.body || '',
      type: data.type,
      direction: MessageDirection.OUTGOING,
      status: data.status || MessageStatus.PENDING,
      metadata: data.metadata,
      timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    });

    if (data.quotedMessageId) {
      message.metadata = {
        ...(message.metadata || {}),
        quotedMessage: { id: data.quotedMessageId },
      };
    }

    return this.messageRepository.save(message);
  }

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.engines.get(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session ${sessionId} is not active or engine not found`);
    }
    return engine;
  }
}
