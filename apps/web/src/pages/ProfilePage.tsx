import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConnectPromptCard } from '../components/attachments';
import { Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Modal, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { ageLabel, attributeSourceLabel, cn, formatAttributeValue, titleCase } from '../lib/format';
import type { DogProfileDto, MediaAssetDto, SocialProviderDescriptorDto } from '../lib/types';
import { PENDING_PROMPT_KEY } from './Landing';

export default function ProfilePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [breedingOpen, setBreedingOpen] = useState(false);

  const { data: dogs, isLoading } = useQuery({
    queryKey: ['dogs'],
    queryFn: () => api.get<DogProfileDto[]>('/dogs'),
  });
  const { data: media } = useQuery({
    queryKey: ['media'],
    queryFn: () => api.get<MediaAssetDto[]>('/media/mine'),
  });
  const { data: providers } = useQuery({
    queryKey: ['social', 'providers'],
    queryFn: () => api.get<SocialProviderDescriptorDto[]>('/social/providers'),
  });

  const confirmAll = useMutation({
    mutationFn: ({ dogId, keys }: { dogId: string; keys: string[] }) =>
      api.post<DogProfileDto>(`/dogs/${dogId}/confirm`, { keys }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['dogs'] }),
  });

  const removePhoto = useMutation({
    mutationFn: (id: string) => api.del(`/media/${id}`),
    onSuccess: () => {
      setDeleteId(null);
      void qc.invalidateQueries({ queryKey: ['media'] });
      void qc.invalidateQueries({ queryKey: ['dogs'] });
    },
  });

  function editByChatting(prompt: string) {
    sessionStorage.setItem(PENDING_PROMPT_KEY, prompt);
    navigate('/app');
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={26} />
      </div>
    );
  }

  const dog = dogs?.[0];

  if (!dog) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="No dog profile yet"
          body="Connect a photo source and the system will work out who your dog is and build the profile for you."
        />
        {providers && <ConnectPromptCard providers={providers} onSend={editByChatting} />}
      </div>
    );
  }

  const unconfirmed = dog.unconfirmedKeys ?? [];
  const photos = (media ?? []).filter((m) => !dog.photos.length || true);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex gap-4">
          <Avatar src={dog.profilePhotoUrl} alt={dog.name ?? 'Your dog'} size={88} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold">{dog.name ?? 'Your dog'}</h1>
            <p className="text-ink-soft">
              {[dog.breed, ageLabel(dog.ageYears), dog.size ? titleCase(dog.size) : null].filter(Boolean).join(' · ')}
            </p>
            <p className="text-sm text-ink-soft">{dog.location.label ?? 'Location not set'}</p>
          </div>
        </div>

        {dog.bio && <p className="mt-3 italic text-ink-soft">“{dog.bio}”</p>}

        <div className="mt-3 flex flex-wrap gap-1">
          {dog.activityLevel && <Badge tone="primary">{titleCase(dog.activityLevel)} energy</Badge>}
          {dog.sociability && <Badge>{titleCase(dog.sociability)}</Badge>}
          {dog.playStyles.map((p) => (
            <Badge key={p}>{titleCase(p)}</Badge>
          ))}
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-ink-soft">
            <span>Profile completeness</span>
            <span>{Math.round((dog.completeness ?? 0) * 100)}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((dog.completeness ?? 0) * 100)}%` }} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => editByChatting('I want to correct something on my dog’s profile')}>
            Edit by chatting
          </Button>
          {unconfirmed.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              loading={confirmAll.isPending}
              onClick={() => confirmAll.mutate({ dogId: dog.id, keys: unconfirmed })}
            >
              Confirm {unconfirmed.length} detail{unconfirmed.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
        <ErrorNote error={confirmAll.error} />
      </Card>

      {/* Photos */}
      <Card>
        <h2 className="font-semibold">Photos</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Location data is stripped from every image. Dimmed photos were not recognised as your dog.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p) => (
            <div key={p.id} className="group relative">
              <img
                src={p.thumbUrl}
                alt=""
                className={cn(
                  'aspect-square w-full rounded-xl object-cover',
                  p.isProfilePhoto && 'ring-2 ring-primary',
                  (p.dogScore ?? 0) < 0.35 && 'opacity-40',
                )}
              />
              <button
                onClick={() => setDeleteId(p.id)}
                aria-label="Delete photo"
                className="absolute right-1 top-1 rounded-full bg-ink/70 px-1.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              >
                ✕
              </button>
              {p.isProfilePhoto && (
                <span className="absolute bottom-1 left-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-white">
                  Profile
                </span>
              )}
            </div>
          ))}
        </div>
        {providers && (
          <div className="mt-4">
            <ConnectPromptCard providers={providers} onSend={editByChatting} />
          </div>
        )}
      </Card>

      {/* Provenance */}
      <Card>
        <h2 className="font-semibold">What we know, and where it came from</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Everything the system inferred is listed with its source and confidence. Nothing here is treated as fact until
          you confirm it.
        </p>
        <div className="ds-scroll mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
                <th className="py-2 pr-3 font-medium">Detail</th>
                <th className="py-2 pr-3 font-medium">Value</th>
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium">Confidence</th>
                <th className="py-2 font-medium">Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dog.attributes ?? {}).map(([key, attr]) => (
                <tr key={key} className={cn('border-b border-line/60', !attr.userConfirmed && 'bg-warn-soft/40')}>
                  <td className="py-2 pr-3">{titleCase(key)}</td>
                  <td className="py-2 pr-3">{formatAttributeValue(attr.value)}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={attr.source === 'user' || attr.source === 'verified_document' ? 'success' : 'neutral'}>
                      {attributeSourceLabel(attr.source)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-ink-soft">{Math.round((attr.confidence ?? 0) * 100)}%</td>
                  <td className="py-2">{attr.userConfirmed ? '✓' : <span className="text-warn">needs check</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Breeding */}
      <BreedingSection dog={dog} open={breedingOpen} setOpen={setBreedingOpen} />

      <ConfirmDialog
        open={!!deleteId}
        title="Delete this photo?"
        body="It will be removed from your profile and deleted from storage."
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteId(null)}
        onConfirm={() => deleteId && removePhoto.mutate(deleteId)}
      />
    </div>
  );
}

function BreedingSection({
  dog,
  open,
  setOpen,
}: {
  dog: DogProfileDto;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const b = dog.breeding;
  const [form, setForm] = useState({
    reproductiveStatus: b?.reproductiveStatus ?? '',
    registrationNumber: b?.registrationNumber ?? '',
    pedigree: b?.pedigree ?? '',
    geneticTests: (b?.geneticTests ?? []).join(', '),
    healthScreenings: (b?.healthScreenings ?? []).join(', '),
    vetClearance: b?.vetClearance ?? '',
    matingNotes: b?.matingNotes ?? '',
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch<DogProfileDto>(`/dogs/${dog.id}/breeding`, {
        ...(form.reproductiveStatus ? { reproductiveStatus: form.reproductiveStatus } : {}),
        ...(form.registrationNumber ? { registrationNumber: form.registrationNumber } : {}),
        ...(form.pedigree ? { pedigree: form.pedigree } : {}),
        geneticTests: form.geneticTests.split(',').map((s) => s.trim()).filter(Boolean),
        healthScreenings: form.healthScreenings.split(',').map((s) => s.trim()).filter(Boolean),
        ...(form.vetClearance ? { vetClearance: form.vetClearance } : {}),
        ...(form.matingNotes ? { matingNotes: form.matingNotes } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['dogs'] });
    },
  });

  return (
    <Card>
      <h2 className="font-semibold">Breeding information</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Only ever what you enter — this is never guessed from photos. Shown exclusively in mating searches.
      </p>

      {b ? (
        <>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-soft">
            <span>Completeness</span>
            <span>{Math.round((b.completeness ?? 0) * 100)}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((b.completeness ?? 0) * 100)}%` }} />
          </div>
          {b.missingFields.length > 0 && (
            <p className="mt-2 text-sm text-ink-soft">Still missing: {b.missingFields.join(', ')}</p>
          )}
        </>
      ) : (
        <p className="mt-3 text-sm text-ink-soft">Nothing recorded yet.</p>
      )}

      <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
        {b ? 'Update breeding details' : 'Add breeding details'}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Breeding details"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Reproductive status</label>
            <select
              value={form.reproductiveStatus}
              onChange={(e) => setForm({ ...form, reproductiveStatus: e.target.value })}
              className="w-full rounded-xl border border-line bg-white px-3 py-2.5"
            >
              <option value="">Not specified</option>
              <option value="intact">Intact</option>
              <option value="neutered">Neutered</option>
              <option value="spayed">Spayed</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <TextInput
            label="Registration number"
            value={form.registrationNumber}
            onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })}
          />
          <TextInput label="Pedigree" value={form.pedigree} onChange={(e) => setForm({ ...form, pedigree: e.target.value })} />
          <TextInput
            label="Genetic tests"
            hint="Comma separated, e.g. prcd-PRA: clear, DM: clear"
            value={form.geneticTests}
            onChange={(e) => setForm({ ...form, geneticTests: e.target.value })}
          />
          <TextInput
            label="Health screenings"
            hint="Comma separated, e.g. Hips OFA Good (2025)"
            value={form.healthScreenings}
            onChange={(e) => setForm({ ...form, healthScreenings: e.target.value })}
          />
          <TextInput
            label="Vet clearance"
            value={form.vetClearance}
            onChange={(e) => setForm({ ...form, vetClearance: e.target.value })}
          />
          <TextInput
            label="Notes for other owners"
            value={form.matingNotes}
            onChange={(e) => setForm({ ...form, matingNotes: e.target.value })}
          />
          <p className="rounded-xl bg-warn-soft p-3 text-xs text-warn">
            Doggystyle helps owners find and talk to each other. It does not assess breeding suitability and is not
            veterinary advice.
          </p>
          <ErrorNote error={save.error} />
        </div>
      </Modal>
    </Card>
  );
}
