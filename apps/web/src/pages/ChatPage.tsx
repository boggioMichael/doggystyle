import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AttachmentView } from '../components/attachments';
import { Button, ErrorNote, Spinner, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { cn } from '../lib/format';
import type { ChatMessageDto, ChatThreadSummary, ChatTurnDto } from '../lib/types';
import { PENDING_PROMPT_KEY } from './Landing';

export default function ChatPage() {
  const qc = useQueryClient();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pendingHandled = useRef(false);

  /* Pick up the newest thread, or start one. */
  const { data: threads } = useQuery({
    queryKey: ['chat', 'threads'],
    queryFn: () => api.get<ChatThreadSummary[]>('/chat/threads'),
  });

  useEffect(() => {
    if (threadId || !threads) return;
    if (threads.length > 0) {
      setThreadId(threads[0]!.id);
    } else {
      void api.post<{ id: string }>('/chat/threads').then((res) => {
        setThreadId(res.id);
        void qc.invalidateQueries({ queryKey: ['chat', 'threads'] });
      });
    }
  }, [threads, threadId, qc]);

  const messagesKey = ['chat', 'messages', threadId] as const;
  const { data: messages, isLoading } = useQuery({
    queryKey: messagesKey,
    queryFn: () => api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`),
    enabled: !!threadId,
  });

  const send = useMutation({
    mutationFn: (text: string) => api.post<ChatTurnDto>(`/chat/threads/${threadId}/messages`, { text }),
    onSuccess: (turn) => {
      appendTurn(turn);
      // The assistant may have changed anything — refresh the affected views.
      for (const key of [['dogs'], ['introductions'], ['connections'], ['meetups'], ['media']]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
  });

  function appendTurn(turn: ChatTurnDto) {
    qc.setQueryData<ChatMessageDto[]>(messagesKey, (prev) => [...(prev ?? []), ...turn.messages]);
  }

  function submit(text: string) {
    const value = text.trim();
    if (!value || !threadId || send.isPending) return;
    setDraft('');
    send.mutate(value);
  }

  /* Auto-send whatever was typed on the landing page. */
  useEffect(() => {
    if (!threadId || pendingHandled.current || isLoading) return;
    const pending = sessionStorage.getItem(PENDING_PROMPT_KEY);
    if (pending) {
      pendingHandled.current = true;
      sessionStorage.removeItem(PENDING_PROMPT_KEY);
      send.mutate(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, isLoading]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, send.isPending]);

  const list = messages ?? [];
  const lastAssistant = [...list].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="flex min-h-[70vh] flex-col">
      <div className="flex-1 space-y-4" data-testid="chat-log">
        {isLoading && (
          <div className="flex justify-center py-10">
            <Spinner size={24} />
          </div>
        )}

        {list.map((message) => (
          <div key={message.id} data-testid={`msg-${message.role}`}>
            <div className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm',
                  message.role === 'user'
                    ? 'bg-primary text-white'
                    : 'border border-line bg-card text-ink',
                )}
              >
                {message.text}
              </div>
            </div>

            {message.attachments.map((attachment, i) => (
              <AttachmentView
                key={`${message.id}-${i}`}
                attachment={attachment}
                onSend={submit}
                onTurn={appendTurn}
              />
            ))}
          </div>
        ))}

        {send.isPending && (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Spinner size={14} />
            thinking…
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {lastAssistant && lastAssistant.suggestions.length > 0 && !send.isPending && (
        <div className="mt-4 flex flex-wrap gap-2">
          {lastAssistant.suggestions.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-primary hover:text-primary-dark"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        className="sticky bottom-16 mt-4 md:bottom-0"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm">
          <TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={1}
            aria-label="Message"
            placeholder="Tell me what you'd like for your dog…"
            className="border-0 bg-transparent px-2 py-1.5 focus:ring-0"
          />
          <Button type="submit" size="sm" disabled={!draft.trim()} loading={send.isPending}>
            Send
          </Button>
        </div>
        <ErrorNote error={send.error} />
      </form>
    </div>
  );
}
