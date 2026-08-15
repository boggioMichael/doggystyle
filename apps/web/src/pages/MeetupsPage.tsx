import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MeetupCard } from '../components/attachments';
import { Button, EmptyState, ErrorNote, Modal, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MeetupDto } from '../lib/types';

const SAFETY_SEEN_KEY = 'ds_safety_ack';

export default function MeetupsPage() {
  const { config } = useAuth();
  const qc = useQueryClient();
  const [safetyOpen, setSafetyOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['meetups'],
    queryFn: () => api.get<MeetupDto[]>('/meetups'),
  });

  const simulate = useMutation({
    mutationFn: (id: string) => api.post<MeetupDto>(`/demo/meetups/${id}/accept`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['meetups'] }),
  });

  // Show the safety briefing once, the first time someone lands here.
  if (!localStorage.getItem(SAFETY_SEEN_KEY) && (data ?? []).length > 0 && !safetyOpen) {
    localStorage.setItem(SAFETY_SEEN_KEY, '1');
    setSafetyOpen(true);
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={24} />
      </div>
    );
  }

  const now = Date.now();
  const all = data ?? [];
  const upcoming = all.filter((m) => m.status !== 'cancelled' && new Date(m.startsAt).getTime() >= now);
  const past = all.filter((m) => m.status !== 'cancelled' && new Date(m.startsAt).getTime() < now);
  const cancelled = all.filter((m) => m.status === 'cancelled');

  return (
    <div className="space-y-6">
      {all.length === 0 && (
        <EmptyState
          title="No meetups yet"
          body="Once you are connected with another owner you can propose a time and place."
        />
      )}

      {[
        ['Upcoming', upcoming],
        ['Past', past],
        ['Cancelled', cancelled],
      ].map(([title, items]) => {
        const list = items as MeetupDto[];
        if (list.length === 0) return null;
        return (
          <section key={title as string}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-soft">{title as string}</h2>
            {list.map((m) => (
              <div key={m.id}>
                <MeetupCard meetup={m} />
                {config?.demoMode && m.status === 'proposed' && m.proposedByMe && (
                  <div className="mt-1 pl-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={simulate.isPending && simulate.variables === m.id}
                      onClick={() => simulate.mutate(m.id)}
                    >
                      Simulate their owner accepting (demo)
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}
      <ErrorNote error={simulate.error} />

      <Modal
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        title="Before you meet"
        footer={<Button onClick={() => setSafetyOpen(false)}>Got it</Button>}
      >
        <ul className="space-y-2">
          <li>• Meet in a public place in daylight for the first time.</li>
          <li>• Tell someone where you are going and when you expect to be back.</li>
          <li>• Keep both dogs leashed until you have both agreed they are comfortable.</li>
          <li>• Watch body language — stiffness, tucked tails or raised hackles mean give them space.</li>
          <li>• You can report or block the other owner at any time from the conversation menu.</li>
        </ul>
      </Modal>
    </div>
  );
}
