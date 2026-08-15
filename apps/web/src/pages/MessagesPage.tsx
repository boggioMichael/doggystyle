import { REPORT_REASONS, REPORT_REASON_LABELS } from '@doggystyle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNote,
  Modal,
  Spinner,
  TextArea,
  TextInput,
} from '../components/ui';
import { api } from '../lib/api';
import { cn, formatRelative, nextSaturdayMorning, toLocalInputValue } from '../lib/format';
import type { ConnectionSummaryDto, MeetupDto, MessageDto } from '../lib/types';

export default function MessagesPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const { data: connections, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<ConnectionSummaryDto[]>('/connections'),
  });

  const active = connections?.find((c) => c.connectionId === connectionId) ?? null;

  const { data: messages } = useQuery({
    queryKey: ['messages', connectionId],
    queryFn: () => api.get<MessageDto[]>(`/connections/${connectionId}/messages`),
    enabled: !!connectionId,
    refetchInterval: 5000,
  });

  const send = useMutation({
    mutationFn: (body: string) => api.post<MessageDto>(`/connections/${connectionId}/messages`, { body }),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['messages', connectionId] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={24} />
      </div>
    );
  }

  if ((connections ?? []).length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        body="Conversations open once both owners accept an introduction."
      />
    );
  }

  /* Mobile: show the list until one is picked. Desktop: two panes. */
  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <div className={cn('space-y-2', connectionId && 'hidden md:block')}>
        {(connections ?? []).map((c) => (
          <button
            key={c.connectionId}
            onClick={() => navigate(`/app/messages/${c.connectionId}`)}
            className={cn(
              'flex w-full items-center gap-3 rounded-2xl border border-line bg-card p-3 text-left transition-colors hover:border-primary',
              c.connectionId === connectionId && 'border-primary',
              c.status === 'revoked' && 'opacity-50',
            )}
          >
            <Avatar src={c.peerDog.photoUrl} alt={c.peerDog.name} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{c.peerDog.name}</p>
              <p className="truncate text-xs text-ink-soft">{c.lastMessagePreview ?? 'Say hello'}</p>
            </div>
            {c.unreadCount > 0 && <Badge tone="primary">{c.unreadCount}</Badge>}
          </button>
        ))}
      </div>

      {active ? (
        <Card className="flex min-h-[60vh] flex-col">
          <div className="flex items-center gap-3 border-b border-line pb-3">
            <button className="md:hidden" onClick={() => navigate('/app/messages')} aria-label="Back">
              ←
            </button>
            <Avatar src={active.peerDog.photoUrl} alt={active.peerDog.name} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{active.peerDog.name}</p>
              <p className="truncate text-xs text-ink-soft">{active.peerOwnerDisplayName}</p>
            </div>
            <MeetupButton connectionId={active.connectionId} />
            <SafetyMenu peerOwnerId={active.peerOwnerId} peerName={active.peerDog.name} />
          </div>

          <div className="ds-scroll flex-1 space-y-2 overflow-y-auto py-3">
            {(messages ?? []).map((m) =>
              m.kind === 'text' ? (
                <div key={m.id} className={cn('flex', m.mine ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[80%] rounded-2xl px-3 py-2 text-sm',
                      m.mine ? 'bg-primary text-white' : 'bg-line/50 text-ink',
                    )}
                  >
                    {m.body}
                    <span className={cn('mt-0.5 block text-[10px]', m.mine ? 'text-white/70' : 'text-ink-soft')}>
                      {formatRelative(m.createdAt)}
                    </span>
                  </div>
                </div>
              ) : (
                <p key={m.id} className="mx-auto max-w-[90%] rounded-full bg-line/40 px-3 py-1 text-center text-xs text-ink-soft">
                  {m.body}
                </p>
              ),
            )}
            <div ref={bottomRef} />
          </div>

          <form
            className="flex items-end gap-2 border-t border-line pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) send.mutate(draft.trim());
            }}
          >
            <TextArea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) send.mutate(draft.trim());
                }
              }}
              rows={1}
              aria-label="Message"
              placeholder="Write a message…"
              disabled={active.status === 'revoked'}
            />
            <Button type="submit" size="sm" loading={send.isPending} disabled={!draft.trim()}>
              Send
            </Button>
          </form>
          <ErrorNote error={send.error} />
        </Card>
      ) : (
        <div className="hidden md:block">
          <EmptyState title="Pick a conversation" />
        </div>
      )}
    </div>
  );
}

function MeetupButton({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [startsAt, setStartsAt] = useState(toLocalInputValue(nextSaturdayMorning()));
  const [duration, setDuration] = useState(90);
  const [note, setNote] = useState('');

  const propose = useMutation({
    mutationFn: () =>
      api.post<MeetupDto>(`/connections/${connectionId}/meetups`, {
        startsAt: new Date(startsAt).toISOString(),
        durationMinutes: duration,
        ...(note ? { locationNote: note } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['meetups'] });
      void qc.invalidateQueries({ queryKey: ['messages', connectionId] });
    },
  });

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Meetup
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Propose a meetup"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={propose.isPending} onClick={() => propose.mutate()}>
              Propose
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <TextInput
            label="When"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
          <div>
            <label className="mb-1 block text-sm font-medium">How long</label>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full rounded-xl border border-line bg-white px-3 py-2.5"
            >
              {[30, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
          <TextInput label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="text-xs text-ink-soft">
            We suggest a public place roughly halfway between you. Neither owner’s address is ever shared.
          </p>
          <ErrorNote error={propose.error} />
        </div>
      </Modal>
    </>
  );
}

function SafetyMenu({ peerOwnerId, peerName }: { peerOwnerId: string; peerName: string }) {
  const qc = useQueryClient();
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [detail, setDetail] = useState('');

  const report = useMutation({
    mutationFn: () => api.post('/moderation/report', { userId: peerOwnerId, reason, detail: detail || undefined }),
    onSuccess: () => setReportOpen(false),
  });
  const block = useMutation({
    mutationFn: () => api.post('/moderation/block', { userId: peerOwnerId }),
    onSuccess: () => {
      setBlockOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  return (
    <>
      <details className="relative">
        <summary className="cursor-pointer list-none rounded-full px-2 py-1 text-ink-soft hover:bg-line" aria-label="More">
          ⋯
        </summary>
        <div className="absolute right-0 z-10 mt-1 w-36 rounded-xl border border-line bg-card p-1 shadow-lg">
          <button onClick={() => setReportOpen(true)} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-line/60">
            Report
          </button>
          <button onClick={() => setBlockOpen(true)} className="block w-full rounded-lg px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50">
            Block
          </button>
        </div>
      </details>

      <Modal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={`Report ${peerName}'s owner`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReportOpen(false)}>
              Cancel
            </Button>
            <Button loading={report.isPending} onClick={() => report.mutate()}>
              Send report
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Reason</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl border border-line bg-white px-3 py-2.5"
            >
              {REPORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REPORT_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <TextArea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} placeholder="Anything else we should know?" />
          <p className="text-xs text-ink-soft">A moderator reviews every report. The other owner is not told who reported them.</p>
          <ErrorNote error={report.error} />
        </div>
      </Modal>

      <ConfirmDialog
        open={blockOpen}
        title={`Block ${peerName}'s owner?`}
        body="Your connection closes, they can no longer message you, and you will not appear in each other's matches."
        confirmLabel="Block"
        danger
        onCancel={() => setBlockOpen(false)}
        onConfirm={() => block.mutate()}
      />
    </>
  );
}
