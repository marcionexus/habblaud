import { appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/types';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { CHAT_TEXT_MAX, readChatAfter, readChatBefore } from './chat';
import { createTerminalParser, TEXT_MAX } from './terminal';

const T0 = Date.parse('2026-10-06T10:00:00Z');
const parser = () => createTerminalParser({ textMax: CHAT_TEXT_MAX });

/** Uma rodada: o prompt, uma ferramenta com resultado volumoso (o "ruído" entre as mensagens) e a resposta. */
function round(i: number, resultBytes = 600): string[] {
  const at = T0 + i * 60_000;
  return [
    L.prompt(`pedido ${i}`, { at }),
    L.assistant([L.tool(`tool-${i}`, 'Bash', { command: `echo ${i}` })], { at: at + 1_000 }),
    L.result(`tool-${i}`, 'x'.repeat(resultBytes), { at: at + 2_000 }),
    L.assistant([L.text(`resposta ${i}`)], { at: at + 3_000 }),
  ];
}

/** Volta página a página até o começo e junta tudo na ordem do arquivo. */
function readAll(path: string, o: Parameters<typeof readChatBefore>[3]): ChatMessage[][] {
  const pages: ChatMessage[][] = [];
  let before: number | undefined;
  for (let i = 0; i < 1_000; i++) {
    const r = readChatBefore(path, before, parser, o);
    pages.unshift(r.messages);
    if (!r.hasMore) break;
    expect(r.start).toBeLessThan(before ?? Infinity);
    before = r.start;
  }
  return pages;
}

describe('histórico do chat — leitura do transcript', () => {
  let dir: string;
  let cleanup: () => void;
  let path: string;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    path = join(dir, 'sessao.jsonl');
  });
  afterEach(() => cleanup());

  it('sem cursor: as mensagens mais recentes, só prompts e respostas, na ordem', () => {
    writeLines(path, Array.from({ length: 40 }, (_, i) => round(i)).flat());
    const r = readChatBefore(path, undefined, parser, { page: 6, chunkBytes: 4_096 });
    expect(r.end).toBe(statSync(path).size);
    expect(r.hasMore).toBe(true);
    expect(r.start).toBeGreaterThan(0);
    expect(r.messages.length).toBeGreaterThanOrEqual(6);
    expect(r.messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(r.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'resposta 39' });
    expect(r.messages.at(-2)).toMatchObject({ role: 'user', text: 'pedido 39', at: T0 + 39 * 60_000 });
  });

  it('voltando página a página chega ao começo, com cada mensagem uma vez só', () => {
    writeLines(path, Array.from({ length: 40 }, (_, i) => round(i)).flat());
    const all = readAll(path, { page: 5, chunkBytes: 3_000 }).flat();
    expect(all.map((m) => m.text)).toEqual(Array.from({ length: 40 }, (_, i) => [`pedido ${i}`, `resposta ${i}`]).flat());
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
  });

  it('texto longo vem inteiro (o terminal cortaria em TEXT_MAX)', () => {
    const longo = `${'linha comprida do plano\n'.repeat(Math.ceil((TEXT_MAX * 2) / 24))}fim do plano`;
    writeLines(path, [L.prompt('faz o plano', { at: T0 }), L.assistant([L.text(longo)], { at: T0 + 1 })]);
    const r = readChatBefore(path, undefined, parser);
    expect(r.messages.at(-1)!.text.length).toBeGreaterThan(TEXT_MAX);
    expect(r.messages.at(-1)!.text.endsWith('fim do plano')).toBe(true);
  });

  it('linha maior que o pedaço não trava a volta e não some', () => {
    writeLines(path, [...round(0), ...round(1, 50_000), ...round(2)]);
    const all = readAll(path, { page: 2, chunkBytes: 1_024 }).flat();
    expect(all.map((m) => m.text)).toEqual(['pedido 0', 'resposta 0', 'pedido 1', 'resposta 1', 'pedido 2', 'resposta 2']);
  });

  it('linha acima do teto é pulada, e o resto continua', () => {
    writeLines(path, [...round(0), L.prompt(`colado ${'y'.repeat(20_000)}`, { at: T0 + 1 }), ...round(1)]);
    const all = readAll(path, { page: 2, chunkBytes: 1_024, lineMax: 8_000 }).flat();
    expect(all.map((m) => m.text)).toEqual(['pedido 0', 'resposta 0', 'pedido 1', 'resposta 1']);
  });

  it('linha ainda sendo escrita fica de fora e chega pela leitura `after`', () => {
    writeLines(path, round(0));
    const nova = L.assistant([L.text('chegou agora')], { at: T0 + 9_000 });
    appendFileSync(path, nova.slice(0, 30));
    const first = readChatBefore(path, undefined, parser);
    expect(first.end).toBeLessThan(statSync(path).size);
    expect(first.messages.at(-1)?.text).toBe('resposta 0');

    expect(readChatAfter(path, first.end, parser)).toMatchObject({ messages: [], end: first.end, reset: false });

    appendFileSync(path, `${nova.slice(30)}\n`);
    appendLines(path, [L.prompt('e agora?', { at: T0 + 10_000 })]);
    const next = readChatAfter(path, first.end, parser);
    expect(next.messages.map((m) => [m.role, m.text])).toEqual([
      ['assistant', 'chegou agora'],
      ['user', 'e agora?'],
    ]);
    expect(next.end).toBe(statSync(path).size);
    expect(next.more).toBe(false);
  });

  it('leitura `after` em partes: `more` até alcançar o fim', () => {
    writeLines(path, round(0));
    const end = statSync(path).size;
    appendLines(path, Array.from({ length: 10 }, (_, i) => round(i + 1)).flat());
    const seen: string[] = [];
    let pos = end;
    for (let i = 0; i < 100; i++) {
      const r = readChatAfter(path, pos, parser, { forwardBytes: 2_048 });
      seen.push(...r.messages.map((m) => m.text));
      expect(r.end).toBeGreaterThan(pos);
      pos = r.end;
      if (!r.more) break;
    }
    expect(pos).toBe(statSync(path).size);
    expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => [`pedido ${i + 1}`, `resposta ${i + 1}`]).flat());
  });

  it('posição depois do fim (transcript encolheu): reset', () => {
    writeLines(path, round(0));
    expect(readChatAfter(path, statSync(path).size + 10, parser).reset).toBe(true);
  });
});
