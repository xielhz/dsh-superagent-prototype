/** Normalizes Telegram Bot API messages into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'

export const SOURCE = 'telegram'
/** Sender of a message; `is_bot` marks bot accounts, which can never originate work on their own. */
export const TelegramFromSchema = z.looseObject({ id: z.number(), is_bot: z.boolean().optional(),
  username: z.string().nullish(), first_name: z.string().nullish() })
export const TelegramChatSchema = z.looseObject({ id: z.number(), type: z.string(), title: z.string().nullish(),
  username: z.string().nullish() })
/** One message as `getUpdates` returns it; an edit arrives as `edited_message` and carries `edit_date`. */
export const TelegramMessageSchema = z.looseObject({ message_id: z.number(), date: z.number(), chat: TelegramChatSchema,
  from: TelegramFromSchema.nullish(), text: z.string().nullish(), caption: z.string().nullish(), edit_date: z.number().nullish(),
  is_topic_message: z.boolean().nullish(), message_thread_id: z.number().nullish(),
  reply_to_message: z.looseObject({ message_id: z.number(), from: TelegramFromSchema.nullish() }).nullish() })
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>
export const TelegramUpdateSchema = z.looseObject({ update_id: z.number(), message: TelegramMessageSchema.nullish(),
  edited_message: TelegramMessageSchema.nullish() })
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>
export const TelegramMeSchema = z.looseObject({ id: z.number(), is_bot: z.boolean(), username: z.string().nullish(),
  first_name: z.string().nullish() })
export type TelegramMe = z.infer<typeof TelegramMeSchema>

/** Thread key of one chat, private or group. */
export const telegramThread = (chatId: string): string => SOURCE + ':' + chatId
/** Reply address of one chat, optionally pinned to the message a reply answers. */
export const telegramChannel = (chatId: string, messageId?: string, direct?: boolean): ChannelRef =>
  ({ source: SOURCE, thread: telegramThread(chatId),
    address: { chatId, ...(messageId ? { messageId } : {}), ...(direct === undefined ? {} : { direct: String(direct) }) } })
/** True when the text addresses `@username`, the way a group message must to reach the bot. */
export const mentions = (text: string, username: string): boolean =>
  !!username && new RegExp('(?:^|[^A-Za-z0-9_@])@' + escapeRegExp(username) + '(?![A-Za-z0-9_])', 'i').test(text)
/** Message text; a photo or document carries its words in `caption`. */
export const messageText = (message: TelegramMessage): string => (message.text ?? message.caption ?? '').trim()
/** Display name of a sender, for Thread titles and the Policy roster. */
export const senderName = (from: { username?: string | null; first_name?: string | null } | null | undefined): string =>
  !from ? '' : from.username ? '@' + from.username : from.first_name ?? ''
/**
 * Trigger ID: the message plus its edit revision. A re-read of the same message dedupes, while an edit produces a new event,
 * the way GitHub's comment Trigger IDs include `updated_at`.
 */
export const telegramTriggerId = (chatId: string, messageId: number, editDate?: number | null): string =>
  key('telegram-message', chatId, String(messageId), editDate ? String(editDate) : '')
/** Builds the Trigger for one message; a private message is directed at the bot, a group one must mention it. */
export function messageTrigger(message: TelegramMessage, me: Pick<TelegramMe, 'username'>): Trigger {
  const chatId = String(message.chat.id)
  const direct = message.chat.type === 'private'
  const from = message.from
  const text = messageText(message)
  const addressed = direct ? 'direct' as const : mentions(text, me.username ?? '') ? 'mention' as const : undefined
  return { id: telegramTriggerId(chatId, message.message_id, message.edit_date), source: SOURCE,
    threads: [{ source: SOURCE, id: chatId }],
    actor: { source: SOURCE, id: from ? String(from.id) : '0' },
    human: !!from && from.is_bot !== true,
    ...(addressed ? { addressed } : {}),
    at: new Date(message.date * 1000).toISOString(), text,
    channel: telegramChannel(chatId, String(message.message_id), direct),
    meta: { chatId, chatType: message.chat.type, direct, messageId: message.message_id,
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      ...(from?.username ? { username: from.username } : {}),
      ...(message.message_thread_id ? { topicId: message.message_thread_id } : {}),
      ...(message.reply_to_message?.message_id ? { parentId: message.reply_to_message.message_id } : {}) } }
}
