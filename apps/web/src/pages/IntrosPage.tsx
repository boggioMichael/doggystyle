import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { IntroductionCard } from '../components/attachments';
import { Button, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/format';
import type { MatchRequestDto } from '../lib/types';

export default function IntrosPage() {
  const { config } = useAuth();
  const qc = useQueryClient();
  const [box, setBox] = useState<'incoming' | 'outgoing'>('incoming');

  const { data, isLoading } = useQuery({
    queryKey: ['introductions', box],
    queryFn: () => api.get<MatchRequestDto[]>(`/introductions?box=${box}`),
  });

  const simulate = useMutation({
    mutationFn: (id: string) => api.post<MatchRequestDto>(`/demo/introductions/${id}/accept`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['introductions'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex rounded-full bg-line/50 p-1 text-sm">
        {(['incoming', 'outgoing'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setBox(key)}
            className={cn(
              'flex-1 rounded-full px-3 py-1.5 capitalize transition-colors',
              box === key ? 'bg-card font-medium shadow-sm' : 'text-ink-soft',
            )}
          >
            {key}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex justify-center py-10">
          <Spinner size={24} />
        </div>
      )}

      {!isLoading && (data ?? []).length === 0 && (
        <EmptyState
          title={box === 'incoming' ? 'No introduction requests yet' : 'You have not asked anyone yet'}
          body={
            box === 'incoming'
              ? 'When another owner asks to meet, it will appear here for you to accept or decline.'
              : 'Find a match in the chat and ask their owner for an introduction.'
          }
        />
      )}

      {(data ?? []).map((request) => (
        <div key={request.id}>
          <IntroductionCard request={request} onSend={() => {}} />
          {config?.demoMode && box === 'outgoing' && request.status === 'pending' && (
            <div className="mt-1 pl-1">
              <Button
                size="sm"
                variant="ghost"
                loading={simulate.isPending && simulate.variables === request.id}
                onClick={() => simulate.mutate(request.id)}
              >
                Simulate their owner accepting (demo)
              </Button>
            </div>
          )}
        </div>
      ))}
      <ErrorNote error={simulate.error} />
    </div>
  );
}
