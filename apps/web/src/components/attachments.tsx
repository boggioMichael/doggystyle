import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ageLabel, cn, formatDateOnly, formatTimeRange, titleCase } from '../lib/format';
import type {
  ChatAttachment,
  ChatTurnDto,
  DogProfileDto,
  MatchCandidateDto,
  MediaImportSummaryDto,
  MeetupDto,
  MatchRequestDto,
  SearchResultDto,
  SocialProviderDescriptorDto,
} from '../lib/types';
import { Avatar, Badge, Button, Card, ErrorNote, Modal, ScoreRing, Spinner } from './ui';

export interface AttachmentHandlers {
  onSend: (text: string) => void;
  onTurn?: (turn: ChatTurnDto) => void;
}

/* ── Profile ──────────────────────────────────────────────────────────────── */

export function ProfileCard({ profile, onSend }: { profile: DogProfileDto } & AttachmentHandlers) {
  const qc = useQueryClient();
  const unconfirmed = profile.unconfirmedKeys ?? [];

  const confirmAll = useMutation({
    mutationFn: () => api.post<DogProfileDto>(`/dogs/${profile.id}/confirm`, { keys: unconfirmed }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dogs'] });
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });

  return (
    <Card className="mt-2">
      <div className="flex gap-4">
        <Avatar src={profile.profilePhotoUrl} alt={profile.name ?? 'Your dog'} size={72} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold">{profile.name ?? 'Your dog'}</h3>
          <p className="text-sm text-ink-soft">
            {[profile.breed, ageLabel(profile.ageYears), profile.size ? titleCase(profile.size) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {profile.activityLevel && <Badge tone="primary">{titleCase(profile.activityLevel)} energy</Badge>}
            {profile.sociability && <Badge>{titleCase(profile.sociability)}</Badge>}
            {(profile.temperament ?? []).slice(0, 3).map((t) => (
              <Badge key={t}>{titleCase(t)}</Badge>
            ))}
          </div>
        </div>
      </div>

      {profile.bio && <p className="mt-3 text-sm italic text-ink-soft">“{profile.bio}”</p>}

      {profile.photos.length > 1 && (
        <div className="ds-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
          {profile.photos.slice(0, 8).map((p) => (
            <img
              key={p.id}
              src={p.thumbUrl}
              alt=""
              className={cn('h-16 w-16 shrink-0 rounded-xl object-cover', p.isProfilePhoto && 'ring-2 ring-primary')}
            />
          ))}
        </div>
      )}

      {unconfirmed.length > 0 && (
        <div className="mt-3 rounded-xl bg-warn-soft p-3">
          <p className="text-sm text-warn">
            <strong>{unconfirmed.length}</strong> detail{unconfirmed.length === 1 ? '' : 's'} I worked out from your
            photos — worth a check:
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {unconfirmed.slice(0, 8).map((k) => (
              <Badge key={k} tone="warn">
                {titleCase(k)}
              </Badge>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={confirmAll.isPending} onClick={() => confirmAll.mutate()}>
              Looks right
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onSend('I want to correct something on the profile')}>
              Something’s wrong
            </Button>
          </div>
          <ErrorNote error={confirmAll.error} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => onSend('Find my dog a compatible dog nearby for a playdate.')}>
          Find matches
        </Button>
        <Link to="/app/profile">
          <Button size="sm" variant="ghost">
            Open full profile
          </Button>
        </Link>
      </div>
    </Card>
  );
}

/* ── Matches ──────────────────────────────────────────────────────────────── */

export function MatchCard({
  candidate,
  intent,
  onSend,
}: { candidate: MatchCandidateDto; intent: string } & AttachmentHandlers) {
  const qc = useQueryClient();
  const [requested, setRequested] = useState(candidate.introductionStatus !== 'none');
  const isMating = intent === 'mating';

  const introduce = useMutation({
    mutationFn: () => api.post<MatchRequestDto>(`/matches/candidates/${candidate.id}/introduce`, {}),
    onSuccess: () => {
      setRequested(true);
      void qc.invalidateQueries({ queryKey: ['introductions'] });
    },
  });

  return (
    <Card className="mt-2">
      <div className="flex gap-3">
        <Avatar src={candidate.photoUrl} alt={candidate.name} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="truncate font-semibold">{candidate.name}</h4>
              <p className="text-sm text-ink-soft">
                {[ageLabel(candidate.ageYears), candidate.breed].filter(Boolean).join(' · ')}
              </p>
              <p className="text-sm text-ink-soft">{candidate.distanceLabel}</p>
            </div>
            <ScoreRing value={Math.round(candidate.score)} label={isMating ? 'data' : 'match'} />
          </div>
        </div>
      </div>

      {candidate.reasons.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Why</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {candidate.reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="text-accent" aria-hidden>
                  •
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidate.conflicts.length > 0 && (
        <div className="mt-3 rounded-xl bg-warn-soft p-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-warn">Heads up</p>
          <ul className="mt-1 space-y-0.5 text-sm text-warn">
            {candidate.conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {candidate.dataGaps.length > 0 && (
        <div className="mt-3 rounded-xl bg-line/50 p-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Not provided yet</p>
          <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
            {candidate.dataGaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {requested ? (
          <Badge tone="success">Introduction requested</Badge>
        ) : (
          <Button size="sm" loading={introduce.isPending} onClick={() => introduce.mutate()}>
            Ask their owner
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onSend('Show me another.')}>
          Show another
        </Button>
      </div>
      <ErrorNote error={introduce.error} />
    </Card>
  );
}

export function MatchList({ result, ...handlers }: { result: SearchResultDto } & AttachmentHandlers) {
  if (result.candidates.length === 0) {
    return (
      <Card className="mt-2">
        <p className="text-sm text-ink-soft">
          {result.notes[0] ?? 'No matches nearby right now — try widening the search radius.'}
        </p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => handlers.onSend('Search within 25 km')}>
            Widen to 25 km
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="mt-2">
      {result.disclaimer && (
        <div className="mb-2 rounded-2xl bg-warn-soft p-3 text-sm text-warn">
          <strong className="block">About mating matches</strong>
          {result.disclaimer}
        </div>
      )}
      {result.candidates.map((c) => (
        <MatchCard key={c.id} candidate={c} intent={result.intent} {...handlers} />
      ))}
    </div>
  );
}

/* ── Introduction ─────────────────────────────────────────────────────────── */

export function IntroductionCard({ request }: { request: MatchRequestDto } & AttachmentHandlers) {
  const qc = useQueryClient();
  const respond = useMutation({
    mutationFn: (accept: boolean) => api.post<MatchRequestDto>(`/introductions/${request.id}/respond`, { accept }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['introductions'] });
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  const peer = request.direction === 'incoming' ? request.fromDog : request.toDog;

  return (
    <Card className="mt-2">
      <div className="flex items-center gap-3">
        <Avatar src={peer.photoUrl} alt={peer.name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {request.direction === 'incoming' ? `${peer.name}'s owner wants to meet` : `You asked ${peer.name}'s owner`}
          </p>
          <p className="text-sm text-ink-soft">{peer.breed}</p>
        </div>
        <Badge tone={request.status === 'accepted' ? 'success' : request.status === 'pending' ? 'warn' : 'neutral'}>
          {titleCase(request.status)}
        </Badge>
      </div>

      {request.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-ink-soft">
          {request.reasons.slice(0, 3).map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}

      {request.direction === 'incoming' && request.status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={respond.isPending} onClick={() => respond.mutate(true)}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" onClick={() => respond.mutate(false)}>
            Decline
          </Button>
        </div>
      )}

      {request.status === 'accepted' && request.connectionId && (
        <Link to={`/app/messages/${request.connectionId}`} className="mt-3 inline-block">
          <Button size="sm" variant="secondary">
            Open conversation
          </Button>
        </Link>
      )}
      <ErrorNote error={respond.error} />
    </Card>
  );
}

/* ── Meetup ───────────────────────────────────────────────────────────────── */

export function MeetupCard({ meetup }: { meetup: MeetupDto } & Partial<AttachmentHandlers>) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['meetups'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
  };
  const respond = useMutation({
    mutationFn: (accept: boolean) => api.post<MeetupDto>(`/meetups/${meetup.id}/respond`, { accept }),
    onSuccess: invalidate,
  });

  const tone = meetup.status === 'accepted' ? 'success' : meetup.status === 'cancelled' ? 'danger' : 'warn';

  return (
    <Card className="mt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate font-semibold">{meetup.title}</h4>
          <p className="text-sm text-ink-soft">{formatDateOnly(meetup.startsAt)}</p>
          <p className="text-sm text-ink-soft">{formatTimeRange(meetup.startsAt, meetup.endsAt)}</p>
        </div>
        <Badge tone={tone}>{titleCase(meetup.status)}</Badge>
      </div>

      <p className="mt-2 flex gap-2 text-sm">
        <span aria-hidden>📍</span>
        <span>{meetup.locationLabel}</span>
      </p>
      {meetup.locationNote && <p className="mt-1 text-sm text-ink-soft">{meetup.locationNote}</p>}

      {meetup.status === 'proposed' && !meetup.proposedByMe && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={respond.isPending} onClick={() => respond.mutate(true)}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" onClick={() => respond.mutate(false)}>
            Decline
          </Button>
        </div>
      )}
      <ErrorNote error={respond.error} />
    </Card>
  );
}

/* ── Media import progress ────────────────────────────────────────────────── */

export function ImportSummaryCard({ summary, onSend }: { summary: MediaImportSummaryDto } & AttachmentHandlers) {
  const { data } = useQuery({
    queryKey: ['import', summary.importId],
    queryFn: () => api.get<MediaImportSummaryDto>(`/social/imports/${summary.importId}`),
    initialData: summary,
    // Poll only while the job is in flight.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'complete' || s === 'failed' ? false : 1500;
    },
  });

  const current = data ?? summary;
  const done = current.status === 'complete';

  return (
    <Card className="mt-2" data-testid="import-card">
      <div className="flex items-center gap-3">
        {done ? <span className="text-xl">📸</span> : <Spinner />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {done
              ? `Imported ${current.itemsStored} photo${current.itemsStored === 1 ? '' : 's'}`
              : current.status === 'failed'
                ? 'Import failed'
                : 'Importing photos…'}
          </p>
          <p className="text-sm text-ink-soft">
            {done
              ? `${current.dogPhotos} look like your dog${current.duplicates ? ` · ${current.duplicates} duplicates skipped` : ''}`
              : current.message ?? 'This takes a few seconds.'}
          </p>
        </div>
      </div>

      {current.clusters.length > 0 && (
        <div className="ds-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
          {current.clusters.map((c) => (
            <div key={c.clusterId} className="shrink-0 text-center">
              {c.coverUrl ? (
                <img src={c.coverUrl} alt="" className="h-16 w-16 rounded-xl object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-primary-soft">🐾</div>
              )}
              <span className="mt-1 block text-[11px] text-ink-soft">{c.count} photos</span>
            </div>
          ))}
        </div>
      )}

      {done && (
        <Button
          className="mt-3"
          size="sm"
          onClick={() => onSend('Build my dog’s profile from the imported photos')}
        >
          Build the profile from these
        </Button>
      )}
    </Card>
  );
}

/* ── Connect prompt ───────────────────────────────────────────────────────── */

export function ConnectPromptCard({
  providers,
  onSend,
  onTurn,
}: { providers: SocialProviderDescriptorDto[] } & AttachmentHandlers) {
  const qc = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  // Once an import starts we show its live progress here rather than asking the
  // assistant to build a profile from photos that have not landed yet.
  const [startedImport, setStartedImport] = useState<MediaImportSummaryDto | null>(null);

  const connect = useMutation({
    mutationFn: (id: string) => api.post<{ importId?: string; redirectUrl?: string }>(`/social/${id}/connect`, {}),
    onSuccess: (res, providerId) => {
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
        return;
      }
      if (res.importId) {
        setStartedImport({
          importId: res.importId,
          provider: providerId as MediaImportSummaryDto['provider'],
          itemsFetched: 0,
          itemsStored: 0,
          duplicates: 0,
          dogPhotos: 0,
          clusters: [],
          status: 'queued',
          message: null,
        });
      }
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!files?.length) throw new Error('Choose at least one photo.');
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      return api.upload<MediaImportSummaryDto>('/media/upload', form);
    },
    onSuccess: (summary) => {
      setUploadOpen(false);
      void qc.invalidateQueries({ queryKey: ['media'] });
      setStartedImport(summary);
    },
  });

  if (startedImport) {
    return <ImportSummaryCard summary={startedImport} onSend={onSend} onTurn={onTurn} />;
  }

  return (
    <Card className="mt-2" data-testid="connect-prompt">
      <p className="text-sm text-ink-soft">Where do your dog’s photos live?</p>
      <div className="mt-3 space-y-2">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{p.label}</p>
              <p className="truncate text-xs text-ink-soft">{p.unavailableReason ?? p.description}</p>
            </div>
            {p.connected ? (
              <Badge tone="success">Connected</Badge>
            ) : p.kind === 'upload' ? (
              <Button size="sm" variant="secondary" onClick={() => setUploadOpen(true)}>
                Upload
              </Button>
            ) : (
              <Button
                size="sm"
                variant={p.id === 'demo' ? 'primary' : 'secondary'}
                disabled={!p.available}
                loading={connect.isPending && connect.variables === p.id}
                onClick={() => connect.mutate(p.id)}
              >
                {p.id === 'demo' ? 'Use demo source' : 'Connect'}
              </Button>
            )}
          </div>
        ))}
      </div>
      <ErrorNote error={connect.error} />

      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload photos"
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button loading={upload.isPending} onClick={() => upload.mutate()}>
              Upload
            </Button>
          </>
        }
      >
        <p className="mb-3 text-ink-soft">
          Pick a few photos of your dog. Location data is stripped from every image before it is stored.
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(e) => setFiles(e.target.files)}
          className="w-full rounded-xl border border-line bg-white p-2 text-sm"
        />
        <ErrorNote error={upload.error} />
      </Modal>
    </Card>
  );
}

/* ── Sensitive-action confirmation ────────────────────────────────────────── */

export function ConfirmationCard({
  confirmation,
  onTurn,
}: { confirmation: NonNullable<Extract<ChatAttachment, { kind: 'confirmation' }>['confirmation']> } & AttachmentHandlers) {
  const [done, setDone] = useState<null | boolean>(null);

  const resolve = useMutation({
    mutationFn: (confirm: boolean) => api.post<ChatTurnDto>(`/chat/confirmations/${confirmation.id}`, { confirm }),
    onSuccess: (turn, confirm) => {
      setDone(confirm);
      onTurn?.(turn);
    },
  });

  if (done !== null) {
    return (
      <Card className="mt-2">
        <Badge tone={done ? 'success' : 'neutral'}>{done ? 'Done' : 'Cancelled'}</Badge>
      </Card>
    );
  }

  return (
    <Card className="mt-2 border-primary/40" data-testid="confirmation-card">
      <p className="font-medium">{confirmation.summary}</p>
      {confirmation.detail.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-ink-soft">
          {confirmation.detail.map((d) => (
            <li key={d}>• {d}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" loading={resolve.isPending && resolve.variables === true} onClick={() => resolve.mutate(true)}>
          Confirm
        </Button>
        <Button size="sm" variant="ghost" onClick={() => resolve.mutate(false)}>
          Cancel
        </Button>
      </div>
      <ErrorNote error={resolve.error} />
    </Card>
  );
}

/* ── Switchboard ──────────────────────────────────────────────────────────── */

export function AttachmentView({ attachment, ...handlers }: { attachment: ChatAttachment } & AttachmentHandlers) {
  switch (attachment.kind) {
    case 'dog_profile':
    case 'profile_draft':
      return <ProfileCard profile={attachment.profile} {...handlers} />;
    case 'matches':
      return <MatchList result={attachment.result} {...handlers} />;
    case 'candidate':
      return <MatchCard candidate={attachment.candidate} intent={attachment.candidate.intent} {...handlers} />;
    case 'introduction':
      return <IntroductionCard request={attachment.request} {...handlers} />;
    case 'meetup':
      return <MeetupCard meetup={attachment.meetup} {...handlers} />;
    case 'media_import':
      return <ImportSummaryCard summary={attachment.summary} {...handlers} />;
    case 'connect_prompt':
      return <ConnectPromptCard providers={attachment.providers} {...handlers} />;
    case 'confirmation':
      return <ConfirmationCard confirmation={attachment.confirmation} {...handlers} />;
    case 'conversation_link':
      return (
        <Card className="mt-2">
          <Link to={`/app/messages/${attachment.connectionId}`}>
            <Button size="sm" variant="secondary">
              Message {attachment.peerDogName}’s owner
            </Button>
          </Link>
        </Card>
      );
    case 'notice':
      return (
        <Card className={cn('mt-2', attachment.tone === 'warning' && 'bg-warn-soft')}>
          <p className="font-medium">{attachment.title}</p>
          <p className="mt-1 text-sm text-ink-soft">{attachment.body}</p>
        </Card>
      );
    default:
      return null;
  }
}
