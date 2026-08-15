import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, ErrorNote, Modal, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { SocialProviderDescriptorDto, ViewerDto } from '../lib/types';

export default function SettingsPage() {
  const { viewer, config, refresh, logout } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState(viewer?.displayName ?? '');
  const [city, setCity] = useState(viewer?.location.city ?? '');
  const [precision, setPrecision] = useState(viewer?.location.precision ?? 'city');
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const { data: providers } = useQuery({
    queryKey: ['social', 'providers'],
    queryFn: () => api.get<SocialProviderDescriptorDto[]>('/social/providers'),
  });

  const saveAccount = useMutation({
    mutationFn: () =>
      api.patch<ViewerDto>('/me', {
        displayName: displayName || undefined,
        city: city || undefined,
        locationPrecision: precision,
      }),
    onSuccess: async () => {
      await refresh();
      setSaved('account');
      void qc.invalidateQueries({ queryKey: ['dogs'] });
    },
  });

  const changePassword = useMutation({
    mutationFn: () => api.post('/me/password', { current: currentPassword, next: nextPassword }),
    onSuccess: () => {
      setCurrentPassword('');
      setNextPassword('');
      setSaved('password');
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.post(`/social/${id}/disconnect`),
    onSuccess: () => {
      setDisconnectId(null);
      void qc.invalidateQueries({ queryKey: ['social', 'providers'] });
    },
  });

  const deleteAccount = useMutation({
    mutationFn: () => api.del('/me', { confirm: true }),
    onSuccess: async () => {
      await logout().catch(() => {});
      navigate('/', { replace: true });
    },
  });

  async function exportData() {
    const data = await api.get<unknown>('/me/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'doggystyle-my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-semibold">Account</h2>
        <div className="mt-3 space-y-3">
          <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <TextInput label="City" list="ds-cities-settings" value={city} onChange={(e) => setCity(e.target.value)} />
          <datalist id="ds-cities-settings">
            {(config?.knownCities ?? []).map((c) => (
              <option key={`${c.city}-${c.country}`} value={c.city} />
            ))}
          </datalist>
          <div className="flex items-center gap-2">
            <Button size="sm" loading={saveAccount.isPending} onClick={() => saveAccount.mutate()}>
              Save
            </Button>
            {saved === 'account' && <Badge tone="success">Saved</Badge>}
          </div>
          <ErrorNote error={saveAccount.error} />
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">Privacy</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Other owners never see your address or precise coordinates — only a rough distance.
        </p>
        <div className="mt-3 space-y-2">
          {(
            [
              ['city', 'City only', 'Matches use your city centre. The most private option.'],
              ['neighbourhood', 'Neighbourhood', 'Slightly better distance accuracy, still coarse.'],
              ['exact', 'Precise (for meetup planning)', 'Stored precisely, but still never shown to anyone.'],
            ] as const
          ).map(([value, label, help]) => (
            <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
              <input
                type="radio"
                name="precision"
                checked={precision === value}
                onChange={() => setPrecision(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-ink-soft">{help}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">Password</h2>
        <div className="mt-3 space-y-3">
          <TextInput
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <TextInput
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters, with a letter and a number."
            value={nextPassword}
            onChange={(e) => setNextPassword(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              loading={changePassword.isPending}
              disabled={!currentPassword || nextPassword.length < 10}
              onClick={() => changePassword.mutate()}
            >
              Change password
            </Button>
            {saved === 'password' && <Badge tone="success">Changed — other sessions signed out</Badge>}
          </div>
          <ErrorNote error={changePassword.error} />
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">Connected sources</h2>
        <div className="mt-3 space-y-2">
          {(providers ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{p.label}</p>
                <p className="truncate text-xs text-ink-soft">{p.accountLabel ?? p.unavailableReason ?? p.description}</p>
              </div>
              {p.connected ? (
                <Button size="sm" variant="ghost" onClick={() => setDisconnectId(p.id)}>
                  Disconnect
                </Button>
              ) : (
                <Badge>{p.available ? 'Available' : 'Unavailable'}</Badge>
              )}
            </div>
          ))}
        </div>
        <ErrorNote error={disconnect.error} />
      </Card>

      <Card>
        <h2 className="font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Export everything we hold, or delete your account and all of its content.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void exportData()}>
            Export my data (JSON)
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>
            Delete my account
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={!!disconnectId}
        title="Disconnect this source?"
        body="No further photos will be imported. Photos already imported stay until you delete them."
        confirmLabel="Disconnect"
        onCancel={() => setDisconnectId(null)}
        onConfirm={() => disconnectId && disconnect.mutate(disconnectId)}
      />

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteText !== 'delete'}
              loading={deleteAccount.isPending}
              onClick={() => deleteAccount.mutate()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p>
          This removes your profile, your dog, your photos and your conversations. It cannot be undone. Type{' '}
          <strong>delete</strong> to confirm.
        </p>
        <TextInput className="mt-3" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} aria-label="Type delete" />
        <ErrorNote error={deleteAccount.error} />
      </Modal>
    </div>
  );
}
