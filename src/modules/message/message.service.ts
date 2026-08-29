import { Injectable, BadRequestException, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
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
  PinMessageDto,
  StarMessageDto,
  VotePollDto,
  UnpinMessageDto,
} from './dto/message-actions.dto';
import { Message, MessageDirection } from './entities/message.entity';
import { SendPacingService } from './send-pacing.service';
import { createLogger } from '../../common/services/logger.service';
import { parseWaId } from '../../engine/identity/wa-id';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { MessageSendService, SaveOutgoingMessageData } from './message-send.service';

export { DEFAULT_TEMPLATE_RENDER_MAX_CHARS } from './message-send.service';

export interface GetMessagesOptions {
  chatId?: string;
  from?: string;
  limit?: number;
  offset?: number;
}

export const DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;

export function resolveMessageListInlineMediaBudgetBytes(): number {
  const parsed = Number.parseInt(process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
}

export const DEFAULT_PIN_DURATION_SECONDS = 86400;

const INERT_MEDIA_MIMETYPE =
  /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|aac|wav|webm))(;|$)/;

function inertMimetype(mimetype: string): string {
  return INERT_MEDIA_MIMETYPE.test(mimetype) ? mimetype : 'application/octet-stream';
}

@Injectable()
export class MessageService {
  private readonly logger = createLogger('MessageService');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly engines: EngineRegistry,
    private readonly messageProjector: MessageProjector,
    private readonly lidMappingStore: LidMappingStoreService,
    private readonly pacing: SendPacingService,
    private readonly sender: MessageSendService,
  ) {}

  sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendText(sessionId, dto);
  }

  sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendImage(sessionId, dto);
  }

  sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendVideo(sessionId, dto);
  }

  sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendAudio(sessionId, dto);
  }

  sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendDocument(sessionId, dto);
  }

  sendLocation(sessionId: string, dto: SendLocationDto): Promise<MessageResponseDto> {
    return this.sender.sendLocation(sessionId, dto);
  }

  sendContact(sessionId: string, dto: SendContactDto): Promise<MessageResponseDto> {
    return this.sender.sendContact(sessionId, dto);
  }

  sendPoll(sessionId: string, dto: SendPollDto): Promise<MessageResponseDto> {
    return this.sender.sendPoll(sessionId, dto);
  }

  sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return this.sender.sendSticker(sessionId, dto);
  }

  reply(sessionId: string, dto: ReplyMessageDto): Promise<MessageResponseDto> {
    return this.sender.reply(sessionId, dto);
  }

  forward(sessionId: string, dto: ForwardMessageDto): Promise<MessageResponseDto> {
    return this.sender.forward(sessionId, dto);
  }

  saveOutgoingMessage(sessionId: string, data: SaveOutgoingMessageData): Promise<Message> {
    return this.sender.saveOutgoingMessage(sessionId, data);
  }

  async getMessages(
    sessionId: string,
    options: GetMessagesOptions = {},
  ): Promise<{ messages: Message[]; total: number }> {
    const { chatId, from } = options;
    const rawLimit = options.limit;
    const rawOffset = options.offset;
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.sessionId = :sessionId', { sessionId })
      .orderBy('message.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (chatId) {
      query.andWhere('message.chatId IN (:...chatIds)', { chatIds: this.resolveJidCandidates(chatId) });
    }

    if (from) {
      query.andWhere('(message.from = :from OR message.author = :from)', { from });
    }

    const [messages, total] = await query.getManyAndCount();
    return { messages, total };
  }

  async getMessage(sessionId: string, messageId: string): Promise<Message> {
    const message = await this.messageRepository.findOne({
      where: { sessionId, waMessageId: messageId },
    });
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found`);
    }
    return message;
  }

  async getChatMedia(
    sessionId: string,
    chatId: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const chatIds = this.resolveJidCandidates(chatId);
    const row = await this.messageRepository.findOne({
      where: { sessionId, chatId: In(chatIds), waMessageId: messageId },
    });
    const inline = (row?.metadata as { media?: { data?: unknown; mimetype?: unknown; omitted?: unknown } })?.media;
    if (inline?.data && typeof inline.data === 'string' && !/^https?:\/\//i.test(inline.data)) {
      const buffer = Buffer.from(inline.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
      const mimetype = typeof inline.mimetype === 'string' ? inertMimetype(inline.mimetype) : 'application/octet-stream';
      return { buffer, mimetype };
    }
    throw new NotFoundException('No media stored for this message');
  }

  async getChatHistory(
    sessionId: string,
    chatId: string,
    limit = 50,
    includeMedia = false,
    deep = false,
    signal?: AbortSignal,
  ) {
    const engine = this.getEngine(sessionId);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return engine.getChatHistory(chatId, safeLimit, includeMedia);
  }

  async deleteMessage(sessionId: string, dto: DeleteMessageDto): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);

    try {
      await this.messageRepository.update({ sessionId, waMessageId: dto.messageId }, { body: '', type: 'revoked' });
    } catch (err) {
      this.logger.warn(`Failed to flag deleted message ${dto.messageId} as revoked`, { error: String(err) });
    }
  }

  async editMessage(sessionId: string, dto: EditMessageDto): Promise<MessageResponseDto> {
    const engine = this.getEngine(sessionId);
    await this.pacing.assertSendAllowed(sessionId, dto.chatId);
    const result = dto.mentions?.length
      ? await engine.editMessage(dto.chatId, dto.messageId, dto.body, dto.mentions)
      : await engine.editMessage(dto.chatId, dto.messageId, dto.body);

    await this.messageProjector.recordOutboundMessageEdit(sessionId, dto.messageId, dto.body);
    return { messageId: result.id, timestamp: result.timestamp };
  }

  async react(sessionId: string, dto: ReactMessageDto): Promise<void> {
    await this.sender.react(sessionId, dto);
  }

  async reactToMessage(sessionId: string, dto: ReactMessageDto): Promise<void> {
    await this.sender.react(sessionId, dto);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  async votePoll(sessionId: string, dto: VotePollDto): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.votePoll(dto.chatId, dto.pollMessageId, dto.options);
  }

  async pinMessage(sessionId: string, dto: PinMessageDto): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.pinMessage(dto.chatId, dto.messageId, dto.durationSeconds ?? 86400);
  }

  async unpinMessage(sessionId: string, dto: UnpinMessageDto): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.unpinMessage(dto.chatId, dto.messageId);
  }

  async starMessage(sessionId: string, dto: StarMessageDto): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.starMessage(dto.chatId, dto.messageId, dto.star);
  }

  private resolveJidCandidates(chatId: string): string[] {
    const parsed = parseWaId(chatId);
    if (!parsed) return [chatId];
    return [chatId, `${parsed.userPart}@c.us`, `${parsed.userPart}@s.whatsapp.net`];
  }

  private getEngine(sessionId: string) {
    return this.engines.require(
      sessionId,
      () => new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`),
    );
  }
}
