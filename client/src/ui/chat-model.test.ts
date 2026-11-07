import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatPage } from '../../../shared/types';
import { appendNewer, chatPreview, chatState, chatUrl, parseChatPage, prependOlder } from './chat-model';

const m = (id: string, role: ChatMessage['role'] = 'user', at = 1): ChatMessage => ({ id, at, role, text: `texto ${id}` });
const page = (messages: ChatMessage[], o: Partial<ChatPage> = {}): ChatPage => ({ agentId: 'a1', key: 'k.jsonl', messages, start: 0, end: 0, hasMore: false, ...o });

describe('histórico do chat — modelo', () => {
  it('URL: sem cursor, só o agente; com cursor, key e a posição', () => {
    expect(chatUrl('claude:.claude:abc')).toBe('/api/agents/claude%3A.claude%3Aabc/chat');
    expect(chatUrl('a1', { key: 'k.jsonl', before: 120 })).toBe('/api/agents/a1/chat?key=k.jsonl&before=120');
    expect(chatUrl('a1', { key: 'k.jsonl', after: 9 })).toBe('/api/agents/a1/chat?key=k.jsonl&after=9');
  });

  it('página fora do formato é null; mensagens estranhas são descartadas', () => {
    expect(parseChatPage(null)).toBeNull();
    expect(parseChatPage({ agentId: 'a1', key: 'k', messages: [], start: -1, end: 0 })).toBeNull();
    const p = parseChatPage({
      agentId: 'a1',
      key: 'k',
      start: 10,
      end: 20,
      hasMore: true,
      more: true,
      messages: [m('1'), { id: '2', at: 1, role: 'system', text: 'x' }, { id: 3 }, m('4', 'assistant')],
    });
    expect(p).toMatchObject({ start: 10, end: 20, hasMore: true, more: true });
    expect(p!.messages.map((x) => x.id)).toEqual(['1', '4']);
    expect(p!.reset).toBeUndefined();
  });

  it('anteriores entram antes; um id repetido fica na posição mais antiga', () => {
    let s = chatState(page([m('c'), m('d'), m('b2')], { start: 500, end: 900, hasMore: true }));
    s = prependOlder(s, page([m('a'), m('b2'), m('b')], { start: 100, hasMore: true }));
    expect(s.messages.map((x) => x.id)).toEqual(['a', 'b2', 'b', 'c', 'd']);
    expect(s).toMatchObject({ start: 100, end: 900, hasMore: true });
  });

  it('novas: só os ids que ainda não estão, e o cursor avança', () => {
    const s0 = chatState(page([m('a'), m('b')], { end: 50 }));
    const r = appendNewer(s0, page([m('b'), m('c'), m('c')], { start: 50, end: 80 }));
    expect(r.added).toBe(1);
    expect(r.state.messages.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.state.end).toBe(80);
    const nada = appendNewer(r.state, page([], { start: 80, end: 80 }));
    expect(nada.added).toBe(0);
    expect(nada.state.messages).toBe(r.state.messages);
  });

  it('prévia: texto curto inteiro; longo nas primeiras linhas, com quantas faltam', () => {
    expect(chatPreview('a\nb', 5)).toEqual({ head: 'a\nb', hidden: 0 });
    expect(chatPreview('1\n2\n3\n4\n5', 2)).toEqual({ head: '1\n2', hidden: 3 });
    expect(chatPreview('1\n2\n\n', 2)).toEqual({ head: '1\n2\n\n', hidden: 0 });
  });
});
