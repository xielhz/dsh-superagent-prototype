/** The Telegram Source: channel posts, the chat window it caches for assessments, and how a chat splits into Threads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import type { ContextState } from '../src/sources/kind.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { chatLabel, ingestUpdate, telegramKind, threadLabel, TelegramConfigSchema, type TelegramConfig }
  from '../src/sources/telegram.ts'
import { messageTrigger, telegramChannel, telegramThreadOf, type TelegramMessage, type TelegramThreading, type TelegramUpdate }
  from '../src/sources/telegram-trigger.ts'
import { CONTEXT_MESSAGES, contextEntry, remember, TELEGRAM_CONTEXT, telegramThreadContext, type TelegramContextMessage }
  from '../src/sources/telegram-context.ts'
import { sendTelegram, setTelegramNotify, setTelegramToken } from '../src/sources/telegram-channel.ts'

/** A Bot API message as `getUpdates` returns it: a supergroup called Ops with one member. */
const message = (fields: Record<string, unknown> = {}): TelegramMessage => ({ message_id: 9, date: 1_760_000_000,
  chat: { id: -100123, type: 'supergroup', title: 'Ops' }, from: { id: 5049, username: 'xielhz' }, text: 'hello',
  ...fields }) as TelegramMessage
const config = (fields: Record<string, unknown> = {}): TelegramConfig =>
  TelegramConfigSchema.parse({ chats: [{ chatId: '-100123', listen: 'all' }], ...fields })
/** A Source context that keeps state in a map and records what a poll round described and received. */
function source() {
  const state = new Map<string, unknown>()
  const described: { key: string; label?: string }[] = []
  const received: Trigger[] = []
  const ctx = {
    state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) },
      keys: () => [...state.keys()] as never },
    threads: { describe: (key: string, description: { label?: string }) => { described.push({ key, ...description }) } },
    receive: async (trigger: Trigger) => { received.push(trigger); return {} },
  } as unknown as SourceContext
  const read = (chatId: string) => state.get(TELEGRAM_CONTEXT(chatId)) as TelegramContextMessage[] | undefined
  const cache: ContextState = { get: key => state.get(key) as never }
  return { ctx, state, described, received, read, cache }
}
const triggerOf = (fields: Record<string, unknown>, threading: TelegramThreading = 'chat') =>
  messageTrigger(message(fields), { username: 'reddshbot' }, threading)
const reply = (chatId = '42'): OutboundMessage => ({ id: 'm1', kind: 'reply', text: '收到',
  channel: telegramChannel(chatId, '9') })

beforeEach(() => { setTelegramToken(undefined); setTelegramNotify(undefined) })
afterEach(() => { vi.unstubAllGlobals() })

describe('telegram threading', () => {
  it('splits a chat by topic, by reply chain, or by message, and keeps the chat whole otherwise', () => {
    const chat = { message_id: 9, date: 1, chat: { id: -100123, type: 'supergroup', title: 'Ops' } }
    expect(telegramThreadOf('-100123', 'chat', { ...chat })).toBe('telegram:-100123')
    expect(telegramThreadOf('-100123', 'topic', { ...chat, message_thread_id: 7 })).toBe('telegram:-100123:t:7')
    expect(telegramThreadOf('-100123', 'topic', { ...chat })).toBe('telegram:-100123')
    expect(telegramThreadOf('-100123', 'reply', { ...chat, reply_to_message: { message_id: 5 } })).toBe('telegram:-100123:r:5')
    expect(telegramThreadOf('-100123', 'reply', { ...chat })).toBe('telegram:-100123')
    expect(telegramThreadOf('-100123', 'message', { ...chat })).toBe('telegram:-100123:m:9')
    // An update that carries no message (a channel post) stays on the chat's own Thread.
    expect(telegramThreadOf('-100123', 'message')).toBe('telegram:-100123')
  })
  it('gives each Thread of a chat its own Trigger and channel, so they can hold separate Tickets', () => {
    const topic = triggerOf({ message_thread_id: 7 }, 'topic')
    expect(topic.threads).toEqual([{ source: 'telegram', id: '-100123:t:7' }])
    expect(topic.channel?.thread).toBe('telegram:-100123:t:7')
    expect(topic.meta).toMatchObject({ chatId: '-100123', topicId: 7 })
    const chain = triggerOf({ reply_to_message: { message_id: 5 } }, 'reply')
    expect(chain.threads).toEqual([{ source: 'telegram', id: '-100123:r:5' }])
    expect(chain.channel?.thread).toBe('telegram:-100123:r:5')
    const own = triggerOf({}, 'message')
    expect(own.threads).toEqual([{ source: 'telegram', id: '-100123:m:9' }])
    // The default mode is the Thread every earlier Trigger was on.
    expect(triggerOf({}).threads).toEqual([{ source: 'telegram', id: '-100123' }])
    expect(triggerOf({ message_thread_id: 7 }).threads).toEqual([{ source: 'telegram', id: '-100123' }])
  })
  it('labels a Thread by the topic, reply or message that threading separated', () => {
    expect(chatLabel(message())).toBe('Ops')
    expect(chatLabel(message({ chat: { id: 5, type: 'private' }, from: { id: 1, username: 'xielhz' } }))).toBe('@xielhz')
    expect(threadLabel(message({ message_thread_id: 7 }), 'topic')).toBe('Ops · topic 7')
    expect(threadLabel(message(), 'topic')).toBe('Ops')
    expect(threadLabel(message({ reply_to_message: { message_id: 5 } }), 'reply')).toBe('Ops · reply to #5')
    expect(threadLabel(message(), 'reply')).toBe('Ops')
    expect(threadLabel(message(), 'message')).toBe('Ops · #9')
    expect(threadLabel(message(), 'chat')).toBe('Ops')
  })
})

describe('telegram updates', () => {
  it('turns a message into work on its Thread and caches it, and records a channel post without asking for work', async () => {
    const source1 = source()
    await ingestUpdate(source1.ctx, { update_id: 1, message: message({ message_thread_id: 7 }) } as TelegramUpdate, config({ threading: 'topic' }), 'reddshbot')
    expect(source1.described[0]).toEqual({ key: 'telegram:-100123:t:7', label: 'Ops · topic 7' })
    expect(source1.received.map(trigger => trigger.text)).toEqual(['hello'])
    expect(source1.received[0]!.meta).toMatchObject({ chatId: '-100123', messageId: 9, topicId: 7 })
    expect(source1.read('-100123')).toEqual([{ id: '9', thread: 'telegram:-100123:t:7', from: '@xielhz',
      at: new Date(1_760_000_000 * 1000).toISOString(), text: 'hello' }])
    // A channel post names the channel and its Thread; nothing there asked the bot to work.
    const post = message({ message_id: 3, chat: { id: -100999, type: 'channel', title: 'News' }, from: undefined, text: 'shipping v2' })
    await ingestUpdate(source1.ctx, { update_id: 2, channel_post: post } as TelegramUpdate, config(), 'reddshbot')
    expect(source1.described.at(-1)).toEqual({ key: 'telegram:-100999', label: 'News' })
    expect(source1.received).toHaveLength(1)
    expect(source1.read('-100999')).toMatchObject([{ id: '3', thread: 'telegram:-100999', from: '', text: 'shipping v2' }])
    // Its edit is read too, without becoming work either.
    await ingestUpdate(source1.ctx, { update_id: 3, edited_channel_post: { ...post, text: 'shipping v3', edit_date: 2 } } as TelegramUpdate, config(), 'reddshbot')
    expect(source1.read('-100999')).toMatchObject([{ id: '3', text: 'shipping v3' }])
    expect(source1.received).toHaveLength(1)
  })
  it('caches a message it is not listening to, so a later mention reads what led to it', async () => {
    const source1 = source()
    const silent = config({ chats: [], otherChats: 'none' })
    await ingestUpdate(source1.ctx, { update_id: 1, message: message({ text: 'unaddressed chatter' }) } as TelegramUpdate, silent, 'reddshbot')
    expect(source1.received).toEqual([])
    expect(source1.described).toEqual([])
    expect(source1.read('-100123')?.map(entry => entry.text)).toEqual(['unaddressed chatter'])
  })
  it('keeps the last twenty messages of a chat and replaces the message an edit revises', async () => {
    const source1 = source()
    for (let id = 1; id <= 25; id++) {
      await ingestUpdate(source1.ctx, { update_id: id, message: message({ message_id: id, text: 'message ' + id }) } as TelegramUpdate, config(), 'reddshbot')
    }
    const kept = source1.read('-100123')!
    expect(kept.map(entry => entry.id)).toEqual(Array.from({ length: CONTEXT_MESSAGES }, (_, index) => String(index + 6)))
    // An edit revises the message in place: it is neither a second entry nor a second Trigger of that message.
    await ingestUpdate(source1.ctx, { update_id: 26, edited_message: message({ message_id: 25, text: 'fixed', edit_date: 5 }) } as TelegramUpdate, config(), 'reddshbot')
    const edited = source1.read('-100123')!
    expect(edited.filter(entry => entry.id === '25')).toEqual([expect.objectContaining({ text: 'fixed' })])
    expect(edited).toHaveLength(CONTEXT_MESSAGES)
    expect(source1.received.at(-1)!.text).toBe('fixed')
  })
})

describe('telegram thread context', () => {
  const entries = (): TelegramContextMessage[] => [
    contextEntry(message({ message_id: 1, message_thread_id: 7, text: 'first' }), 'telegram:-100123:t:7'),
    contextEntry(message({ message_id: 2, message_thread_id: 7, text: 'second' }), 'telegram:-100123:t:7'),
    contextEntry(message({ message_id: 3, message_thread_id: 8, text: 'other topic' }), 'telegram:-100123:t:8'),
    contextEntry(message({ message_id: 4, text: 'chat level' }), 'telegram:-100123'),
  ]
  const state = (kept: TelegramContextMessage[]): ContextState => ({ get: key => (key === TELEGRAM_CONTEXT('-100123') ? kept : undefined) as never })
  it('reads a Thread\'s own messages out of the chat window', async () => {
    const thread = triggerOf({ message_id: 2, message_thread_id: 7 }, 'topic')
    const read = await telegramThreadContext.read({} as never, thread, 'thread', undefined, config(), state(entries()))
    expect(read.status).toBe('thread')
    expect(read.messages.map(entry => entry.text)).toEqual(['first', 'second'])
    expect(read.body).toMatchObject({ chat: '-100123', thread: 'telegram:-100123:t:7' })
    expect(telegramThreadContext.messageId(thread)).toBe('2')
  })
  it('reads the chat a message was said in when its Thread holds that message alone', async () => {
    const own = triggerOf({ message_id: 3 }, 'message')
    const read = await telegramThreadContext.read({} as never, own, 'thread', undefined, config(), state(entries()))
    expect(read.status).toBe('chat_neighbours')
    expect(read.messages.map(entry => entry.text)).toEqual(['first', 'second', 'other topic', 'chat level'])
  })
  it('reads the message a reply answers, and the message a reply Thread is rooted at', async () => {
    const replied = triggerOf({ message_id: 9, reply_to_message: { message_id: 2 } }, 'reply')
    const parent = await telegramThreadContext.read({} as never, replied, 'parent', undefined, config(), state(entries()))
    expect(parent.status).toBe('available')
    expect(parent.messages.map(entry => entry.text)).toEqual(['second'])
    const root = await telegramThreadContext.read({} as never, replied, 'root', undefined, config(), state(entries()))
    expect(root.status).toBe('available')
    expect(root.messages.map(entry => entry.id)).toEqual(['2'])
    // A chat Thread names no message, and a message that left the window is not invented.
    expect((await telegramThreadContext.read({} as never, triggerOf({}), 'root', undefined, config(), state(entries()))).status).toBe('no_root')
    expect((await telegramThreadContext.read({} as never, triggerOf({}), 'parent', undefined, config(), state(entries()))).status).toBe('no_parent')
  })
  it('refuses a Trigger of another Source', async () => {
    const trigger = { ...triggerOf({}), source: 'github' } as Trigger
    await expect(telegramThreadContext.read({} as never, trigger, 'thread', undefined, config(), state([]))).rejects.toThrow('Telegram source trigger')
  })
})

describe('telegram channel', () => {
  const fetched = () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const fetch = vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
      return { json: async () => ({ ok: true }) }
    })
    vi.stubGlobal('fetch', fetch)
    return calls
  }
  it('mirrors a reply into the notification chat, once, and only when it is another chat', async () => {
    const calls = fetched()
    setTelegramToken('token')
    setTelegramNotify('-100999')
    expect(await sendTelegram({} as never, reply())).toBe('sent')
    expect(calls.map(call => call.body.chat_id)).toEqual(['42', '-100999'])
    expect(calls[1]!.body).toMatchObject({ text: '收到', link_preview_options: { is_disabled: true } })
    expect(calls[1]!.body).not.toHaveProperty('reply_parameters')
    // The chat a reply already goes to is not mirrored to itself, and no notification chat means no second send.
    calls.length = 0
    setTelegramNotify('42')
    await sendTelegram({} as never, reply())
    expect(calls).toHaveLength(1)
    calls.length = 0
    setTelegramNotify(undefined)
    await sendTelegram({} as never, reply())
    expect(calls).toHaveLength(1)
  })
  it('keeps the reply that went out when the mirror fails, and reports a chat it can never reach as gone', async () => {
    setTelegramToken('token')
    setTelegramNotify('-100999')
    let first = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (first) { first = false; return { json: async () => ({ ok: true }) } }
      throw new Error('network down')
    }))
    expect(await sendTelegram({} as never, reply())).toBe('sent')
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) })))
    expect(await sendTelegram({} as never, reply())).toBe('gone')
  })
})

describe('telegram config', () => {
  it('defaults to one Thread per chat and no notification chat, and accepts both settings', () => {
    expect(TelegramConfigSchema.parse({})).toMatchObject({ threading: 'chat', notifyChatId: '' })
    expect(TelegramConfigSchema.parse({ threading: 'topic', notifyChatId: '-1001234567890' })).toMatchObject({ threading: 'topic',
      notifyChatId: '-1001234567890' })
    expect(() => TelegramConfigSchema.parse({ threading: 'forum' })).toThrow()
    expect(() => TelegramConfigSchema.parse({ notifyChatId: '@channel' })).toThrow('A chat ID is digits')
  })
  it('offers the mode and the notification chat in the settings fields', () => {
    const threading = telegramKind.fields.find(field => field.key === 'threading')!
    expect(threading).toMatchObject({ type: 'select', options: [{ value: 'chat' }, { value: 'topic' }, { value: 'reply' }, { value: 'message' }] })
    expect(telegramKind.fields.find(field => field.key === 'notifyChatId')).toMatchObject({ type: 'text', advanced: true, pattern: '-?\\d+' })
  })
  it('remembers a message of a chat in arrival order, dropping the oldest beyond the limit', () => {
    const kept = [1, 2, 3].map(id => contextEntry(message({ message_id: id }), 'telegram:-100123'))
    expect(remember(kept, contextEntry(message({ message_id: 4 }), 'telegram:-100123'), 3).map(entry => entry.id)).toEqual(['2', '3', '4'])
    expect(remember(undefined, kept[0]!).map(entry => entry.id)).toEqual(['1'])
  })
})
