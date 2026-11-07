// Modelo do histórico do chat (ui/chat.ts): URL das páginas, validação do que o servidor manda e a junção das páginas.
// Puro, testado em ui/chat-model.test.ts.
//
// Um id repetido fica na posição mais antiga, como no terminal: o Claude Code às vezes regrava um trecho da conversa
// mais adiante no transcript (ao retomar a sessão), e a cópia não deve aparecer duas vezes.
import type { ChatMessage, ChatPage } from '../../../shared/types';

/** Intervalo das buscas por mensagens novas enquanto a janela está aberta. */
export const CHAT_POLL_MS = 2_000;
/** Ainda há mensagens novas além do que veio (`more`): busca de novo logo. */
export const CHAT_MORE_MS = 150;
/** Mensagem longa (texto colado, plano grande): recolhida nas primeiras linhas, com "Mostrar tudo". */
export const CHAT_PREVIEW_LINES = 40;
/** Distância do topo (px) que já pede as mensagens anteriores. */
export const CHAT_OLDER_PX = 160;

export interface ChatCursor {
  key: string;
  before?: number;
  after?: number;
}

export function chatUrl(agentId: string, c?: ChatCursor): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/chat`;
  if (!c) return base;
  const q = new URLSearchParams({ key: c.key });
  if (c.before !== undefined) q.set('before', String(c.before));
  if (c.after !== undefined) q.set('after', String(c.after));
  return `${base}?${q.toString()}`;
}

function isPos(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** A página do servidor, ou null fora do formato. Mensagens fora do formato são descartadas. */
export function parseChatPage(data: unknown): ChatPage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.agentId !== 'string' || typeof d.key !== 'string' || !Array.isArray(d.messages)) return null;
  if (!isPos(d.start) || !isPos(d.end)) return null;
  const messages: ChatMessage[] = [];
  for (const raw of d.messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ id: m.id, at: m.at, role: m.role, text: m.text });
  }
  const page: ChatPage = { agentId: d.agentId, key: d.key, messages, start: d.start, end: d.end, hasMore: d.hasMore === true };
  if (d.more === true) page.more = true;
  if (d.reset === true) page.reset = true;
  return page;
}

export interface ChatState {
  key: string;
  /** Na ordem do transcript, sem ids repetidos. */
  messages: ChatMessage[];
  /** Cursor das anteriores. */
  start: number;
  /** Cursor das novas. */
  end: number;
  hasMore: boolean;
}

/** Sem ids repetidos, mantendo a primeira ocorrência. */
function unique(list: readonly ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return list.filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
}

/** Primeira página (ou a que substitui tudo, num reset). */
export function chatState(p: ChatPage): ChatState {
  return { key: p.key, messages: unique(p.messages), start: p.start, end: p.end, hasMore: p.hasMore };
}

/** Página anterior: as mensagens dela vêm antes das que já estão; um id que já estava passa para a posição antiga. */
export function prependOlder(s: ChatState, p: ChatPage): ChatState {
  const older = unique(p.messages);
  const ids = new Set(older.map((m) => m.id));
  return { ...s, messages: [...older, ...s.messages.filter((m) => !ids.has(m.id))], start: p.start, hasMore: p.hasMore };
}

/** Mensagens novas: só as que ainda não estão. Devolve o estado e quantas entraram. */
export function appendNewer(s: ChatState, p: ChatPage): { state: ChatState; added: number } {
  const ids = new Set(s.messages.map((m) => m.id));
  const fresh = unique(p.messages).filter((m) => !ids.has(m.id));
  return { state: { ...s, messages: fresh.length ? [...s.messages, ...fresh] : s.messages, end: Math.max(s.end, p.end) }, added: fresh.length };
}

/** Chave do dia (local) de um horário: separa a conversa por dia. */
export function chatDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Texto longo: as primeiras `maxLines` linhas e quantas ficaram de fora (0 = cabe inteiro). */
export function chatPreview(text: string, maxLines = CHAT_PREVIEW_LINES): { head: string; hidden: number } {
  let nl = -1;
  for (let n = 0; n < maxLines; n++) {
    nl = text.indexOf('\n', nl + 1);
    if (nl === -1) return { head: text, hidden: 0 };
  }
  const rest = text.slice(nl + 1);
  if (!rest.trim()) return { head: text, hidden: 0 };
  return { head: text.slice(0, nl), hidden: rest.split('\n').length };
}
