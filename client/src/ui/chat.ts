// Histórico do chat: janela flutuante com a conversa inteira de um agente, só os seus prompts e as respostas dele, em
// balões e com o texto completo (o terminal, ui/terminal.ts, mostra cada ferramenta, mas só o fim da conversa e com os
// textos cortados). Abre nas mensagens mais recentes; rolar até o topo (ou "Carregar mensagens anteriores") busca as
// de antes, até o começo da sessão. As novas chegam a cada CHAT_POLL_MS enquanto a janela está aberta. O rodapé tem a
// mesma caixa de mensagem do terminal (ui/composer.ts). Usa o visual da janela do terminal (.ui-term) com os balões
// próprios (.ui-chat__*). O modelo (cursores, junção das páginas, ids repetidos) está em ui/chat-model.ts.
import type { AgentInfo, ChatMessage, ChatPage } from '../../../shared/types';
import {
  appendNewer,
  CHAT_MORE_MS,
  CHAT_OLDER_PX,
  CHAT_POLL_MS,
  chatDayKey,
  chatPreview,
  chatState,
  chatUrl,
  parseChatPage,
  prependOlder,
  type ChatCursor,
  type ChatState,
} from './chat-model';
import { MessageComposer } from './composer';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { formatClock } from './format';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { maximizeButton, Movable } from './movable';
import { intlLocale, tr } from '../../../shared/i18n';

/** Distância do fim (px) que ainda conta como "no fim" para seguir as mensagens novas. */
const STICK_PX = 32;
const COPIED_MS = 1_500;
const dayFmt = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

export interface ChatControl {
  readonly agentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  close(): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
}

function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

async function fetchPage(url: string, signal: AbortSignal): Promise<ChatPage> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Corpo vazio ou que não é JSON: o erro sai pelo status.
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new Error(err);
  }
  const page = parseChatPage(body);
  if (!page) throw new Error(tr('resposta inesperada do servidor'));
  return page;
}

export class ChatPanel implements UiComponent, ChatControl {
  readonly el: HTMLElement;
  private id: string | null = null;
  private last: AgentInfo | null = null;
  private opener: HTMLElement | null = null;
  private state: ChatState | null = null;
  /** Pedidos da janela atual (fechar ou trocar de agente cancela todos). */
  private abort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private loadingOlder = false;
  private failed = false;
  /** Grudado no fim: mensagens novas rolam a tela. */
  private follow = true;
  private unread = 0;
  /** Balão já montado de cada mensagem (o markdown não é refeito a cada página). */
  private bubbles = new Map<string, HTMLElement>();

  private nameEl: HTMLElement;
  private roomEl: HTMLElement;
  private countEl: HTMLElement;
  private alertEl: HTMLElement;
  private alertText: HTMLElement;
  private scroll: HTMLElement;
  private olderBtn: HTMLButtonElement;
  private beginEl: HTMLElement;
  private list: HTMLElement;
  private placeholder: HTMLElement;
  private newBtn: HTMLButtonElement;
  private movable: Movable;
  private composer: MessageComposer;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.chat;
    this.nameEl = h('strong', { class: 'ui-term__name' });
    this.roomEl = h('span', { class: 'ui-term__room' });
    this.countEl = h('span', { class: 'ui-chat__count', attrs: { 'aria-live': 'polite' } });
    const close = iconButton(ICONS.close, tr('Fechar o histórico do chat (Esc)'), () => this.close(), 'ui-icon-btn--sm ui-term__close');
    const bar = h(
      'div',
      { class: 'ui-term__bar' },
      icon,
      h('span', { class: 'ui-term__kind', text: tr('chat') }),
      h('div', { class: 'ui-term__who' }, this.nameEl, this.roomEl),
      this.countEl,
      maximizeButton(() => this.movable),
      close,
    );

    const retry = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Tentar de novo'), on: { click: () => this.retry() } });
    this.alertText = h('span', { class: 'ui-term__alert-text' });
    this.alertEl = h('div', { class: 'ui-term__alert', role: 'alert', hidden: true }, this.alertText, retry);
    this.olderBtn = h('button', { class: 'ui-btn ui-btn--sm ui-chat__older', type: 'button', hidden: true, text: tr('Carregar mensagens anteriores'), on: { click: () => void this.loadOlder() } });
    this.beginEl = h('p', { class: 'ui-term__note', text: tr('Começo da conversa'), hidden: true });
    this.list = h('div', { class: 'ui-chat__list' });
    this.placeholder = h('p', { class: 'ui-term__placeholder' });
    this.scroll = h('div', { class: 'ui-term__scroll ui-chat__scroll', tabIndex: 0, attrs: { 'aria-label': tr('Histórico do chat') } }, this.olderBtn, this.beginEl, this.list, this.placeholder);
    this.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.newBtn = h('button', { class: 'ui-term__new', type: 'button', hidden: true, on: { click: () => this.jumpToEnd() } });

    this.composer = new MessageComposer(ctx, 'terminal', { onEscape: () => this.scroll.focus({ preventScroll: true }) });

    this.el = h(
      'section',
      { class: 'ui-term ui-chat', role: 'dialog', hidden: true, tabIndex: -1, attrs: { 'aria-label': tr('Histórico do chat') } },
      bar,
      h('div', { class: 'ui-term__body' }, this.alertEl, this.scroll, this.newBtn),
      h('div', { class: 'ui-term__foot' }, this.composer.el),
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.chat', enabled: () => !ctx.isNarrow() });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.follow && this.scrollToEnd()).observe(this.scroll);
  }

  get agentId(): string | null {
    return this.id;
  }

  get isOpen(): boolean {
    return this.id !== null;
  }

  open(agentId: string, opener: HTMLElement | null = activeElement()): void {
    if (opener && !this.el.contains(opener)) this.opener = opener;
    if (this.id === agentId) {
      this.scroll.focus({ preventScroll: true });
      return;
    }
    this.stop();
    this.reset();
    this.id = agentId;
    this.last = this.ctx.agent(agentId) ?? null;
    if (this.el.hidden) this.movable.restore();
    this.el.hidden = false;
    this.render();
    this.scroll.focus({ preventScroll: true });
    void this.loadLatest();
    this.ctx.invalidate();
  }

  close(): void {
    if (this.id === null) return;
    this.stop();
    const hadFocus = this.el.contains(document.activeElement) || document.activeElement === document.body;
    this.id = null;
    this.last = null;
    this.el.hidden = true;
    this.reset();
    const opener = this.opener;
    this.opener = null;
    if (hadFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(agentId: string, opener: HTMLElement | null = activeElement()): void {
    if (this.id === agentId) this.close();
    else this.open(agentId, opener);
  }

  /** Esc: fecha. Devolve false se não estava aberta. */
  escape(): boolean {
    if (this.id === null) return false;
    this.close();
    return true;
  }

  render(): void {
    if (this.id === null) return;
    const live = this.ctx.agent(this.id);
    if (live) this.last = live;
    const a = this.last;
    const name = a?.name ?? tr('Agente');
    setText(this.nameEl, a?.title ? `${name} · ${a.title}` : name);
    setTitle(this.nameEl, a?.title ?? '');
    const room = a ? this.ctx.store.room(a.roomId) : undefined;
    setText(this.roomEl, room ? tr('sala {0}', [room.name]) : '');
    setHidden(this.roomEl, !room);
    setAttr(this.el, 'aria-label', tr('Histórico do chat de {0}', [name]));
    this.el.classList.toggle('is-gone', !live);
    const n = this.state?.messages.length ?? 0;
    setText(this.countEl, n ? tr('{0} mensagens', [n]) : '');
    this.composer.render(live, this.id);
  }

  // ---------------------------------------------------------------- carregamento

  private stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.loadingOlder = false;
  }

  private reset(): void {
    this.state = null;
    this.failed = false;
    this.follow = true;
    this.unread = 0;
    this.bubbles.clear();
    this.list.replaceChildren();
    setHidden(this.alertEl, true);
    setHidden(this.olderBtn, true);
    setHidden(this.beginEl, true);
    setHidden(this.newBtn, true);
    setText(this.placeholder, tr('Carregando a conversa…'));
    setHidden(this.placeholder, false);
  }

  private signal(): AbortSignal {
    if (!this.abort) this.abort = new AbortController();
    return this.abort.signal;
  }

  private retry(): void {
    if (this.id === null) return;
    setHidden(this.alertEl, true);
    if (this.state) this.schedule(0);
    else void this.loadLatest();
  }

  private showError(err: unknown): void {
    if ((err as Error)?.name === 'AbortError') return;
    this.failed = true;
    setText(this.alertText, tr('Não foi possível carregar o histórico do chat: {0}', [err instanceof Error ? err.message : String(err)]));
    setHidden(this.alertEl, false);
    if (!this.state) setHidden(this.placeholder, true);
  }

  private async loadLatest(): Promise<void> {
    const id = this.id;
    if (id === null) return;
    try {
      const page = await fetchPage(chatUrl(id), this.signal());
      if (this.id !== id) return;
      this.state = chatState(page);
      this.failed = false;
      this.layout(null);
      this.scrollToEnd();
      this.render();
      this.schedule(page.more ? CHAT_MORE_MS : CHAT_POLL_MS);
      // A primeira página pode não encher a janela: já busca as anteriores.
      this.maybeLoadOlder();
    } catch (err) {
      if (this.id === id) this.showError(err);
    }
  }

  private schedule(ms: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    const id = this.id;
    const s = this.state;
    if (id === null || !s) return;
    const cursor: ChatCursor = { key: s.key, after: s.end };
    try {
      const page = await fetchPage(chatUrl(id, cursor), this.signal());
      if (this.id !== id || this.state !== s) return;
      if (this.failed) {
        this.failed = false;
        setHidden(this.alertEl, true);
      }
      if (page.reset) {
        // /clear ou transcript trocado: a conversa nova substitui tudo.
        this.bubbles.clear();
        this.state = chatState(page);
        this.follow = true;
        this.layout(null);
        this.scrollToEnd();
      } else {
        const r = appendNewer(s, page);
        this.state = r.state;
        if (r.added) {
          this.layout(this.follow ? null : this.captureAnchor());
          if (this.follow) this.scrollToEnd();
          else this.unread += r.added;
          this.renderNewButton();
        }
      }
      this.render();
      this.schedule(page.more ? CHAT_MORE_MS : CHAT_POLL_MS);
    } catch (err) {
      if (this.id !== id) return;
      this.showError(err);
      // Servidor fora do ar por um instante: tenta de novo devagar.
      this.schedule(CHAT_POLL_MS * 3);
    }
  }

  private maybeLoadOlder(): void {
    if (this.state?.hasMore && !this.loadingOlder && this.scroll.scrollTop <= CHAT_OLDER_PX) void this.loadOlder();
  }

  private async loadOlder(): Promise<void> {
    const id = this.id;
    const s = this.state;
    if (id === null || !s || !s.hasMore || this.loadingOlder) return;
    this.loadingOlder = true;
    this.olderBtn.disabled = true;
    setText(this.olderBtn, tr('Carregando…'));
    try {
      const page = await fetchPage(chatUrl(id, { key: s.key, before: s.start }), this.signal());
      if (this.id !== id || this.state !== s) return;
      if (page.reset) {
        this.bubbles.clear();
        this.state = chatState(page);
        this.layout(null);
        this.scrollToEnd();
      } else {
        const anchor = this.captureAnchor();
        this.state = prependOlder(s, page);
        this.layout(anchor);
      }
      this.render();
    } catch (err) {
      if (this.id === id) this.showError(err);
    } finally {
      if (this.id === id) {
        this.loadingOlder = false;
        this.olderBtn.disabled = false;
        setText(this.olderBtn, tr('Carregar mensagens anteriores'));
        // Ainda perto do topo (página curta): continua voltando.
        if (!this.failed) this.maybeLoadOlder();
      }
    }
  }

  // ---------------------------------------------------------------- montagem

  /**
   * Monta a lista na ordem do estado (com um separador a cada dia), reaproveitando os balões já montados. `anchor`: a
   * mensagem que estava no topo da tela continua no mesmo lugar (ao carregar as anteriores ou com o usuário lendo).
   */
  private layout(anchor: { id: string; offset: number } | null): void {
    const s = this.state;
    if (!s) return;
    const nodes: HTMLElement[] = [];
    const keep = new Set<string>();
    let day = '';
    for (const m of s.messages) {
      const d = chatDayKey(m.at);
      if (d !== day) {
        day = d;
        nodes.push(h('p', { class: 'ui-term__note ui-chat__day', text: dayFmt.format(m.at) }));
      }
      let el = this.bubbles.get(m.id);
      if (!el) {
        el = this.buildBubble(m);
        this.bubbles.set(m.id, el);
      }
      keep.add(m.id);
      nodes.push(el);
    }
    for (const id of [...this.bubbles.keys()]) if (!keep.has(id)) this.bubbles.delete(id);
    this.list.replaceChildren(...nodes);
    setHidden(this.olderBtn, !s.hasMore);
    setHidden(this.beginEl, s.hasMore || s.messages.length === 0);
    setText(this.placeholder, tr('Nenhuma mensagem nesta conversa ainda.'));
    setHidden(this.placeholder, s.messages.length > 0);
    if (anchor) {
      const el = this.bubbles.get(anchor.id);
      if (el) this.scroll.scrollTop = el.offsetTop - anchor.offset;
    }
  }

  private buildBubble(m: ChatMessage): HTMLElement {
    const mine = m.role === 'user';
    const body = h('div', { class: mine ? 'ui-chat__text' : 'ui-chat__text ui-md' });
    const fill = (text: string) => {
      if (mine) body.textContent = text;
      else body.replaceChildren(renderMarkdown(text));
    };
    const { head, hidden } = chatPreview(m.text);
    fill(hidden ? head : m.text);
    const more = hidden
      ? h('button', {
          class: 'ui-chat__more',
          type: 'button',
          text: tr('Mostrar tudo (+{0} linhas)', [hidden]),
          on: {
            click: (e) => {
              fill(m.text);
              (e.currentTarget as HTMLElement).remove();
            },
          },
        })
      : null;
    const copy = iconButton(ICONS.copy, tr('Copiar a mensagem'), (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      void copyText(m.text).then((ok) => {
        if (!ok) return;
        btn.classList.add('is-copied');
        setTitle(btn, tr('Copiado'));
        setTimeout(() => {
          btn.classList.remove('is-copied');
          setTitle(btn, tr('Copiar a mensagem'));
        }, COPIED_MS);
      });
    }, 'ui-icon-btn--sm ui-chat__copy');
    const who = mine ? tr('Você') : this.last?.name ?? tr('Agente');
    const meta = h('div', { class: 'ui-chat__meta' }, h('span', { class: 'ui-chat__who', text: who }), h('time', { class: 'ui-chat__time', text: formatClock(m.at, false) }), copy);
    return h('article', { class: `ui-chat__msg ${mine ? 'is-user' : 'is-agent'}`, attrs: { 'data-id': m.id } }, meta, body, ...(more ? [more] : []));
  }

  // ---------------------------------------------------------------- rolagem

  /** A primeira mensagem (na ordem da tela) que aparece no topo da janela, e onde ela está. */
  private captureAnchor(): { id: string; offset: number } | null {
    const top = this.scroll.scrollTop;
    for (const el of this.list.children) {
      const id = (el as HTMLElement).dataset.id;
      if (!id) continue;
      const e = el as HTMLElement;
      if (e.offsetTop + e.offsetHeight > top) return { id, offset: e.offsetTop - top };
    }
    return null;
  }

  private distanceToEnd(): number {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }

  private onScroll(): void {
    this.maybeLoadOlder();
    const atEnd = this.distanceToEnd() <= STICK_PX;
    if (atEnd === this.follow) return;
    this.follow = atEnd;
    if (atEnd) this.unread = 0;
    this.renderNewButton();
  }

  private scrollToEnd(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private jumpToEnd(): void {
    this.follow = true;
    this.unread = 0;
    this.scrollToEnd();
    this.renderNewButton();
  }

  private renderNewButton(): void {
    const show = !this.follow && this.unread > 0;
    setHidden(this.newBtn, !show);
    if (show) setText(this.newBtn, this.unread === 1 ? tr('1 mensagem nova ↓') : tr('{0} mensagens novas ↓', [this.unread]));
  }
}
