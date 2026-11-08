/** Telegram source kind: long-polls the Bot API, turns messages into Triggers, and replies in the same chat. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { record } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import { sendTelegram, setTelegramNotify, setTelegramToken, telegramLink } from './telegram-channel.ts'
import { contextEntry, remember, TELEGRAM_CONTEXT, telegramThreadContext } from './telegram-context.ts'
import { SOURCE, TelegramMeSchema, TelegramUpdateSchema, messageTrigger, senderName, telegramThread, telegramThreadOf,
  type TelegramMessage, type TelegramMe, type TelegramThreading, type TelegramUpdate } from './telegram-trigger.ts'

export { SOURCE, messageTrigger, telegramChannel, telegramThread, telegramThreadOf, telegramTriggerId } from './telegram-trigger.ts'
export type { TelegramMessage, TelegramMe, TelegramThreading, TelegramUpdate } from './telegram-trigger.ts'
export { CONTEXT_MESSAGES, TELEGRAM_CONTEXT, telegramThreadContext } from './telegram-context.ts'

/** `getUpdates` cursor: the next update to read, so a restart resumes instead of replaying the chat's backlog. */
const OFFSET = record<number>('telegram-offset')
const DEFAULT_TOKEN_FILE = 'C:\\Users\\Dell\\.dsh\\secrets\\superagent-telegram-token.txt'
const API = 'https://api.telegram.org/bot'

export const TelegramConfigSchema = z.object({
  tokenFile: z.string().trim().min(1).default(DEFAULT_TOKEN_FILE),
  botUsername: z.string().trim().max(64).default(''),
  pollSeconds: z.number().int().min(5).max(60).default(50),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  chats: z.array(z.object({ chatId: z.string().regex(/^-?\d+$/), name: z.string().trim().max(60).optional(),
    listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
  // How one chat splits into Threads; `chat` keeps every message of a chat on the Thread it always had.
  threading: z.enum(['chat', 'topic', 'reply', 'message']).default('chat'),
  // A chat every reply is mirrored to, so a channel can follow the work without being the chat that asked; empty turns it off.
  notifyChatId: z.string().trim().regex(/^(-?\d+)?$/, 'A chat ID is digits, optionally with a leading minus').default(''),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

/** Title of a chat's Thread: the sender in a private chat, the chat's own title in a group. */
export const chatLabel = (message: TelegramMessage): string => message.chat.type === 'private'
  ? senderName(message.from) || String(message.chat.id) : message.chat.title || String(message.chat.id)
/**
 * Title of the Thread `threading` puts a message on: the chat's own title, plus the topic, the message a reply answers or the
 * message itself when the mode separates them, so a chat's Threads are told apart in the panel.
 */
export const threadLabel = (message: TelegramMessage, threading: TelegramThreading): string => {
  const chat = chatLabel(message)
  if (threading === 'topic' && message.message_thread_id) return chat + ' · topic ' + message.message_thread_id
  if (threading === 'reply' && message.reply_to_message?.message_id) return chat + ' · reply to #' + message.reply_to_message.message_id
  if (threading === 'message') return chat + ' · #' + message.message_id
  return chat
}

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: { zh: '接收下列群和私聊中发给机器人的消息，回复发回同一个对话。', en: 'Receives messages to the bot in these chats and direct messages; replies go back to the same conversation.' },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'tokenFile', type: 'text', label: { zh: '机器人令牌文件', en: 'Bot token file' },
      hint: { zh: '存放 BotFather 给的 HTTP API Token 的文本文件绝对路径。令牌只从这个文件读，不写进设置；保存后重启 dsh-superagent。', en: 'Absolute path of the text file holding the HTTP API token from BotFather. The token is read from that file only and never stored in settings; restart dsh-superagent after saving.' } },
    { key: 'botUsername', type: 'text', label: { zh: '机器人用户名', en: 'Bot username' },
      hint: { zh: '不带 @。决定群里哪些消息算 @ 了机器人；留空时用 getMe 的结果。', en: 'Without the @. Decides which group messages count as mentioning the bot; filled in from getMe when empty.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。', en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '-?\\d+' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'threading', type: 'select', label: { zh: '对话分线方式', en: 'Threading' },
      options: [
        { value: 'chat', label: { zh: '整个群一条线程', en: 'One Thread per chat' } },
        { value: 'topic', label: { zh: '每个话题一条线程', en: 'One Thread per topic' } },
        { value: 'reply', label: { zh: '每条回复链一条线程', en: 'One Thread per reply chain' } },
        { value: 'message', label: { zh: '每条消息一条线程', en: 'One Thread per message' } },
      ],
      hint: { zh: '一条线程可以有自己的工单。“每个话题”把论坛群的每个话题分开，一个话题一条对话、一张工单，天然并行；“每条回复链”把回复并到它答复的那条消息上；“每条消息”最接近飞书，每条新消息自成一条线程。', en: 'A Thread can have its own Ticket. "One per topic" separates the topics of a forum group, so each topic is one conversation and one Ticket that run in parallel; "One per reply chain" joins a reply to the message it answers; "One per message" comes closest to Feishu, where every new message starts its own Thread.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 60, label: { zh: '长轮询秒数', en: 'Long-poll seconds' },
      hint: { zh: 'getUpdates 的长轮询超时；这一轮结束后才开始下一轮。', en: 'getUpdates long-poll timeout; the next round starts after it returns.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'notifyChatId', type: 'text', advanced: true, pattern: '-?\\d+', label: { zh: '通知频道 chat id', en: 'Notification chat ID' },
      hint: { zh: '填一个频道或群的 chat id：每条回复除了发给原对话，也把同样的文字镜像到这里，方便频道里的其他人看进展。镜像失败不影响原回复；留空表示不镜像。用负数表示频道或超级群（例如 -1001234567890）。', en: 'A channel or group chat ID: every reply is also mirrored there, word for word, so the people following a channel see the progress. A failed mirror leaves the reply that was sent alone; empty turns mirroring off. Channels and supergroups take a negative ID (such as -1001234567890).' } },
  ],
  health: ['telegram'],
  threadContext: telegramThreadContext,
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chatId = String(meta.chatId ?? '')
    const chat = config.chats.find(item => item.chatId === chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a conversation the Source still receives.
  channel: {
    allowed: (address, config) => telegramKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened,
    send: sendTelegram, link: telegramLink,
  },
  policy: {
    unnamed: { person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate Telegram user IDs').default([]),
      bots: z.array(z.object({ id: z.string().regex(/^\d+$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot IDs').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Telegram 用户', en: 'Telegram users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '\\d+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的对话里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。', en: 'Messages of a bot on this list, in conversations the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '机器人 ID', en: 'Bot ID' }, pattern: '\\d+' }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人私聊机器人，或在群里 @ 机器人。', en: 'Someone on the list who messages the bot directly, or mentions it in a group.' },
    rows(stored) {
      const config = TelegramConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: { zh: '接下工单的 Telegram 对话 chat id；工单不是从 Telegram 来的时为空', en: 'chat id of the Telegram conversation that started the ticket; empty when the ticket did not start on Telegram' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '' }),
  },
}

/** Reads the bot token from its file; a missing or empty file leaves the Source waiting rather than failing. */
async function readToken(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return text.trim() || undefined
  } catch { return undefined }
}
/** One Bot API call; a non-`ok` answer becomes an error carrying Telegram's own description. */
async function api<T>(token: string, method: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<T> {
  const response = body
    ? await fetch(API + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
    : await fetch(API + token + '/' + method, { signal })
  const parsed = await response.json() as { ok?: boolean; error_code?: number; description?: string; result?: unknown }
  if (!parsed.ok) throw new Error('Telegram ' + method + ' failed: ' + String(parsed.error_code ?? response.status) + ' ' + (parsed.description ?? ''))
  return parsed.result as T
}
/** Reports an error health once `failures` consecutive polls fail, so a single network blip stays quiet. */
export const pollFailure = (failures: number, threshold: number, error: unknown) =>
  failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined

/**
 * Takes in one Bot API update. A message becomes a Trigger on its Thread; a channel post names the channel and records its
 * Thread without becoming work, because nobody asked the bot anything there. Both are kept in the chat's context window,
 * which is all an assessment can be given: `getUpdates` serves no history.
 */
export async function ingestUpdate(ctx: SourceContext, update: TelegramUpdate, config: TelegramConfig, username: string): Promise<void> {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post
  if (!message) return
  const chatId = String(message.chat.id)
  const post = !update.message && !update.edited_message
  const trigger = post ? undefined : messageTrigger(message, { username }, config.threading)
  const thread = trigger?.channel?.thread ?? telegramThread(chatId)
  // Every message the Source read joins the window, including ones not listened to: a later mention reads what led to it.
  const key = TELEGRAM_CONTEXT(chatId)
  ctx.state.set(key, remember(ctx.state.get(key), contextEntry(message, thread)))
  if (!trigger) { ctx.threads.describe(thread, { label: chatLabel(message) }); return }
  if (!telegramKind.scope!({ meta: trigger.meta }, config).listened) return
  ctx.threads.describe(thread, { label: threadLabel(message, config.threading) })
  await ctx.receive(trigger)
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>(SOURCE)
    if (!config) { ctx.report('telegram', health('paused', 'sourceOff')); await pause(10_000, signal); continue }
    const token = await readToken(config.tokenFile)
    if (!token) { ctx.report('telegram', { state: 'paused', detail: 'Waiting for the bot token file ' + config.tokenFile }); await pause(10_000, signal); continue }
    setTelegramToken(token)
    try {
      const me = await api<TelegramMe>(token, 'getMe', undefined, signal)
      const username = config.botUsername || me.username || ''
      ctx.report('telegram', { state: 'ready', detail: 'connected as @' + (me.username ?? String(me.id)) + '; long-poll ' + config.pollSeconds + 's', at: new Date().toISOString() })
      failures = 0
      let offset = ctx.state.get(OFFSET)
      if (offset === undefined) {
        // First run: drain the backlog and start from the newest update, so a fresh install does not replay old chat.
        const latest = await api<TelegramUpdate[]>(token, 'getUpdates', { offset: -1, limit: 1, timeout: 0 }, signal)
        offset = latest.length ? latest[0]!.update_id + 1 : 1
        ctx.state.set(OFFSET, offset)
      }
      setTelegramNotify(config.notifyChatId || undefined)
      const updates = await api<TelegramUpdate[]>(token, 'getUpdates',
        { offset, timeout: config.pollSeconds, allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'] }, signal)
      for (const update of updates) {
        if (signal.aborted) return
        // The cursor advances whether or not the message is admitted: it was read, and re-reading it would only loop.
        ctx.state.set(OFFSET, update.update_id + 1)
        await ingestUpdate(ctx, update, config, username)
      }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config.failuresBeforeError, error)
      if (!signal.aborted && failed) ctx.report('telegram', failed)
      await pause(Math.min(5_000 * failures, 30_000), signal)
    }
  }
}

export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, telegramKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('telegram', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
