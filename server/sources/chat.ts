// Histórico do chat: lê o transcript JSONL inteiro, aos pedaços, e devolve só a conversa (prompts e respostas do
// agente) com o texto inteiro. Diferente do terminal (http/terminal.ts), que lê só o fim do arquivo (≈4 MB), aqui dá
// para voltar até o começo da sessão: `readChatBefore` lê de trás para frente a partir de uma posição até juntar
// CHAT_PAGE mensagens, e `readChatAfter` lê o que chegou depois de uma posição.
//
// Cada pedaço começa num começo de linha e termina num fim de linha, e passa por um parser NOVO (o estado do parser
// só junta linhas vizinhas da mesma mensagem). As posições devolvidas são os cursores da página seguinte.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ChatMessage } from '../../shared/types';
import type { TerminalParser } from './terminal';

/** Mensagens mínimas por página (para trás); uma página pode trazer mais (o pedaço inteiro em que elas estavam). */
export const CHAT_PAGE = 30;
/** Limite (caracteres) de cada mensagem: na prática, o texto inteiro. */
export const CHAT_TEXT_MAX = 400_000;
/** Tamanho de cada pedaço lido de trás para frente. */
export const CHAT_CHUNK_BYTES = 2 * 1024 * 1024;
/** Teto de bytes lidos por página (para trás): um trecho só de ferramentas não prende o servidor. */
export const CHAT_SCAN_BYTES = 48 * 1024 * 1024;
/** Teto de bytes lidos por página (para frente); o resto vem na próxima (`more`). */
export const CHAT_FORWARD_BYTES = 8 * 1024 * 1024;
/** Linha maior que isto (um resultado de ferramenta enorme) é pulada sem ser lida. */
export const CHAT_LINE_MAX = 32 * 1024 * 1024;
/** Passo das buscas por uma quebra de linha. */
const SEEK_STEP = 64 * 1024;
const NL = 0x0a;

export interface ChatReadOptions {
  page?: number;
  chunkBytes?: number;
  scanBytes?: number;
  forwardBytes?: number;
  lineMax?: number;
}

export interface ChatRead {
  messages: ChatMessage[];
  start: number;
  end: number;
  hasMore: boolean;
}

export interface ChatReadAfter extends ChatRead {
  more: boolean;
  /** A posição pedida passou do fim do arquivo (truncado ou substituído). */
  reset: boolean;
}

function read(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, to - from));
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, from + off);
    if (n <= 0) break;
    off += n;
  }
  return off === buf.length ? buf : buf.subarray(0, off);
}

/** Começo da linha que contém o byte `pos - 1` (o byte depois do `\n` anterior), ou 0. */
function lineStartBefore(fd: number, pos: number): number {
  let to = pos;
  while (to > 0) {
    const from = Math.max(0, to - SEEK_STEP);
    const i = read(fd, from, to).lastIndexOf(NL);
    if (i !== -1) return from + i + 1;
    to = from;
  }
  return 0;
}

/** Fim (depois do `\n`) da linha que começa em `pos`, ou -1 se ela ainda não terminou. */
function lineEndAfter(fd: number, pos: number, size: number): number {
  let from = pos;
  while (from < size) {
    const to = Math.min(size, from + SEEK_STEP);
    const i = read(fd, from, to).indexOf(NL);
    if (i !== -1) return from + i + 1;
    from = to;
  }
  return -1;
}

/** Só a conversa: prompts e respostas, na ordem do arquivo. Uma linha que faça o parser falhar é pulada. */
function parseChat(text: string, parser: TerminalParser): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entries;
    try {
      entries = parser.push(line);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.kind === 'user' || e.kind === 'assistant') out.push({ id: e.id, at: e.at, role: e.kind, text: e.text });
    }
  }
  return out;
}

/**
 * As mensagens antes de `before` (sem ela: as mais recentes). Sem `before`, o fim do arquivo é o fim da última linha
 * completa: uma linha ainda sendo escrita fica para a próxima leitura `after`.
 */
export function readChatBefore(path: string, before: number | undefined, createParser: () => TerminalParser, o: ChatReadOptions = {}): ChatRead {
  const page = o.page ?? CHAT_PAGE;
  const chunkBytes = o.chunkBytes ?? CHAT_CHUNK_BYTES;
  const scanBytes = o.scanBytes ?? CHAT_SCAN_BYTES;
  const lineMax = o.lineMax ?? CHAT_LINE_MAX;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const end = before === undefined ? lineStartBefore(fd, size) : Math.min(before, size);
    // Pedaços lidos de trás para frente; no fim, ficam na ordem do arquivo.
    const pieces: ChatMessage[][] = [];
    let count = 0;
    let pos = end;
    while (pos > 0 && count < page && end - pos < scanBytes) {
      const from = Math.max(0, pos - chunkBytes);
      const buf = read(fd, from, pos);
      let start = from;
      let text: string;
      // `pos` é um começo de linha: o último byte do pedaço é o `\n` da linha anterior e não conta.
      const nl = from > 0 ? buf.subarray(0, buf.length - 1).indexOf(NL) : -1;
      if (from === 0) {
        text = buf.toString('utf8');
      } else if (nl !== -1) {
        start = from + nl + 1;
        text = buf.toString('utf8', nl + 1);
      } else {
        // O pedaço inteiro é o meio de uma linha só: lê a linha inteira (ou a pula, se for enorme).
        start = lineStartBefore(fd, from);
        text = pos - start <= lineMax ? read(fd, start, pos).toString('utf8') : '';
      }
      const msgs = parseChat(text, createParser());
      pieces.push(msgs);
      count += msgs.length;
      pos = start;
    }
    return { messages: pieces.reverse().flat(), start: pos, end, hasMore: pos > 0 };
  } finally {
    closeSync(fd);
  }
}

/** As mensagens que chegaram depois de `after` (até o fim da última linha completa, no máximo `forwardBytes`). */
export function readChatAfter(path: string, after: number, createParser: () => TerminalParser, o: ChatReadOptions = {}): ChatReadAfter {
  const forwardBytes = o.forwardBytes ?? CHAT_FORWARD_BYTES;
  const lineMax = o.lineMax ?? CHAT_LINE_MAX;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (after > size) return { messages: [], start: after, end: after, hasMore: false, more: false, reset: true };
    const to = Math.min(size, after + forwardBytes);
    const buf = read(fd, after, to);
    const last = buf.lastIndexOf(NL);
    let end: number;
    let text: string;
    if (last !== -1) {
      end = after + last + 1;
      text = buf.toString('utf8', 0, last + 1);
    } else if (to < size) {
      // Uma linha só, maior que o limite da leitura: lê a linha inteira (ou a pula, se for enorme).
      const lineEnd = lineEndAfter(fd, to, size);
      if (lineEnd === -1) return { messages: [], start: after, end: after, hasMore: false, more: false, reset: false };
      end = lineEnd;
      text = end - after <= lineMax ? read(fd, after, end).toString('utf8') : '';
    } else {
      // Nada novo, ou só uma linha ainda sendo escrita.
      return { messages: [], start: after, end: after, hasMore: false, more: false, reset: false };
    }
    const messages = parseChat(text, createParser());
    return { messages, start: after, end, hasMore: false, more: end < size && to < size, reset: false };
  } finally {
    closeSync(fd);
  }
}
