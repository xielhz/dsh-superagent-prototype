/** Telegram outbound channel: posts replies through the Bot API and builds message deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { telegramTriggerId } from './telegram-trigger.ts'

const API = 'https://api.telegram.org/bot'
/**
 * The token the running Source resolved from its token file. The channel keeps it because an OutboundMessage carries only
 * its address, never the Source's configuration; the polling loop sets it on every round.
 */
let token: string | undefined
export const setTelegramToken = (value: string | undefined): void => { token = value }
/**
 * The chat every reply is mirrored to, when the Source is configured with one (a channel the work is announced in). Kept
 * beside the token for the same reason: the channel sees only a reply's address.
 */
let notifyChatId: string | undefined
export const setTelegramNotify = (value: string | undefined): void => { notifyChatId = value }
/** Deep link to a message; a group's internal link drops the -100 prefix Telegram adds to chat IDs. */
export function telegramMessageLink(chatId: string, messageId: string): string {
  if (!chatId || !messageId) return ''
  const internal = chatId.startsWith('-') ? chatId.replace(/^-100/, '').replace(/^-/, '') : chatId
  return 'https://t.me/c/' + internal + '/' + messageId
}
export const telegramLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: telegramMessageLink(address.chatId ?? '', address.messageId ?? ''),
  label: { zh: 'Telegram 消息', en: 'Telegram message' },
  ...(address.messageId ? { triggerId: telegramTriggerId(address.chatId ?? '', Number(address.messageId)) } : {}),
})
/** Telegram permanently refusing the chat (blocked, kicked, deleted, wrong ID) is `gone`; anything else may succeed later. */
const gone = (code: number | undefined, description: string): boolean => code === 403 || /chat not found|bot was blocked|bot was kicked|user is deactivated|PEER_ID_INVALID|CHAT_WRITE_FORBIDDEN/i.test(description)
/** Sends one reply as plain text: the plugin's IM messages are short by policy, and plain text cannot break a parse mode. */
export async function sendTelegram(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  if (!token) throw new Error('The Telegram Source has no bot token yet')
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing Telegram reply target')
  const text = checkedImText(message.text)
  const replyTo = Number(message.channel.address.messageId)
  const response = await fetch(API + token + '/sendMessage', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true },
      ...(Number.isFinite(replyTo) && replyTo > 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }) })
  const body = await response.json() as { ok?: boolean; error_code?: number; description?: string }
  if (!body.ok) {
    if (gone(body.error_code, body.description ?? '')) return 'gone'
    throw new Error('Telegram sendMessage failed: ' + String(body.error_code ?? response.status) + ' ' + (body.description ?? ''))
  }
  await mirror(text, chatId)
  return 'sent'
}
/**
 * Mirrors the reply's text into the configured notification chat, so a channel can follow the work without being the chat
 * that asked for it. The main reply has already gone out and a mirror is a courtesy: this never throws.
 */
async function mirror(text: string, chatId: string): Promise<void> {
  const target = notifyChatId
  if (!target || target === chatId) return
  try {
    await fetch(API + token + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text, link_preview_options: { is_disabled: true } }) })
  } catch { /* A mirror that fails (blocked, kicked, wrong ID) must not fail the reply that was sent. */ }
}
