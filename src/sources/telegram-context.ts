/**
 * Telegram Thread context: the Bot API serves no message history, so the poll loop caches the messages it receives and an
 * assessment reads a Thread out of that cache instead of asking Telegram for it.
 */
import { family } from '../kv.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import type { TelegramConfig } from './telegram.ts'
import { messageText, senderName, SOURCE, type TelegramMessage } from './telegram-trigger.ts'

/** Messages kept per chat: the cache is the whole window an assessment can read, so it stays small. */
export const CONTEXT_MESSAGES = 20
/** One cached message, with the Thread `threading` puts it on, so a Thread is read out of its chat's window. */
export interface TelegramContextMessage extends ContextMessage { thread: string }
/** Recent messages of each chat in the order they arrived; the poll loop writes them and assessments read them by Thread. */
export const TELEGRAM_CONTEXT = family<TelegramContextMessage[], [chat: string]>('telegram-context:')

/** The cache entry of one message: who wrote it, when, what it says, and the Thread it belongs to. */
export function contextEntry(message: TelegramMessage, thread: string): TelegramContextMessage {
  const from = message.from
  return { id: String(message.message_id), thread, from: senderName(from) || String(from?.id ?? ''),
    at: new Date(message.date * 1000).toISOString(), text: messageText(message), ...from?.is_bot === true ? { bot: true } : {},
    ...message.reply_to_message?.message_id ? { reply_to: String(message.reply_to_message.message_id) } : {} }
}
/** Appends `entry` to a chat's window, replacing the message an edit revises and keeping the last `limit` messages. */
export function remember(cached: readonly TelegramContextMessage[] | undefined, entry: TelegramContextMessage,
  limit = CONTEXT_MESSAGES): TelegramContextMessage[] {
  return [...(cached ?? []).filter(message => message.id !== entry.id), entry]
    .sort((a, b) => Number(a.id) - Number(b.id)).slice(-limit)
}
/** The message a Thread key is rooted at, when it names one: `:r:` the message a reply answers, `:m:` and `:t:` the message itself. */
function rootOf(thread: string): string {
  return /:[rmt]:(\d+)$/.exec(thread)?.[1] ?? ''
}
function part(messages: TelegramContextMessage[], status: string, body: Record<string, unknown> = {}): ContextPart {
  return { messages, body: { status, messages, ...body }, status }
}
/**
 * Reads a Trigger's Thread from the chat window the poll loop cached. A Thread that `threading` keeps to one message (every
 * message of `message` mode, a reply nobody answered) reads the chat it was said in, marked `chat_neighbours`, so an
 * assessment still sees what came before. There is nothing to fetch, so a page is the whole window.
 */
export const telegramThreadContext: ThreadContext<TelegramConfig> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  async read(_commands, trigger, section, _cursor, _config, state) {
    const chatId = String(trigger.meta.chatId ?? '')
    if (trigger.source !== SOURCE || !chatId) throw new Error('A Telegram source trigger is required')
    const cached = state.get(TELEGRAM_CONTEXT(chatId)) ?? []
    const thread = trigger.channel?.thread ?? ''
    if (section === 'thread') {
      const scoped = cached.filter(message => message.thread === thread)
      const own = scoped.length >= 2
      return part(own ? scoped : cached, own ? 'thread' : 'chat_neighbours', { chat: chatId, thread })
    }
    const id = section === 'parent' ? String(trigger.meta.parentId ?? '') : rootOf(thread)
    const message = cached.find(item => item.id === id)
    const status = message ? 'available' : 'no_' + section
    return message ? part([message], status, { chat: chatId, thread }) : { messages: [], body: { status, chat: chatId, thread }, status }
  },
}
