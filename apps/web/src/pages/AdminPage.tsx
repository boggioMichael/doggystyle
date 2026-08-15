import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorNote, Modal, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, formatRelative, titleCase } from '../lib/format';
import type { AdminEmailRow, AdminUserRowDto, AuditEventDto, JobRowDto, ReportDto } from '../lib/types';

type Tab = 'users' | 'reports' | 'jobs' | 'audit' | 'mailbox';

const TABS: Array<[Tab, string]> = [
  ['users', 'Users'],
  ['reports', 'Reports'],
  ['jobs', 'Jobs'],
  ['audit', 'Audit'],
  ['mailbox', 'Mailbox'],
];

export default function AdminPage() {
  const { viewer } = useAuth();
  const [tab, setTab] = useState<Tab>('users');

  if (viewer?.role !== 'admin') {
    return <EmptyState title="Administrators only" body="This area needs an admin account." />;
  }

  return (
    <div className="space-y-4">
      <div className="ds-scroll flex gap-1 overflow-x-auto rounded-full bg-line/50 p-1 text-sm">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1.5 transition-colors',
              tab === key ? 'bg-card font-medium shadow-sm' : 'text-ink-soft',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'mailbox' && <MailboxTab />}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="ds-scroll overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<AdminUserRowDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', query],
    queryFn: () => api.get<AdminUserRowDto[]>(`/admin/users${query ? `?query=${encodeURIComponent(query)}` : ''}`),
  });

  const suspend = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      api.post(`/admin/users/${id}/suspend`, { suspend: value }),
    onSuccess: () => {
      setTarget(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  return (
    <Card>
      <TextInput placeholder="Search by email or name" value={query} onChange={(e) => setQuery(e.target.value)} />
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="mt-3">
          <Table head={['Email', 'Name', 'Role', 'Status', 'Dogs', 'Reports', 'Action']}>
            {(data ?? []).map((u) => (
              <tr key={u.id} className="border-b border-line/60">
                <td className="py-2 pr-3">{u.email}</td>
                <td className="py-2 pr-3">{u.displayName ?? '—'}</td>
                <td className="py-2 pr-3">{u.role === 'admin' ? <Badge tone="primary">admin</Badge> : 'user'}</td>
                <td className="py-2 pr-3">
                  <Badge tone={u.status === 'active' ? 'success' : 'danger'}>{u.status}</Badge>
                </td>
                <td className="py-2 pr-3">{u.dogCount}</td>
                <td className="py-2 pr-3">{u.reportsAgainst > 0 ? <Badge tone="warn">{u.reportsAgainst}</Badge> : '0'}</td>
                <td className="py-2">
                  {u.role !== 'admin' && (
                    <Button size="sm" variant="ghost" onClick={() => setTarget(u)}>
                      {u.status === 'active' ? 'Suspend' : 'Reinstate'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <ErrorNote error={suspend.error} />

      <ConfirmDialog
        open={!!target}
        title={target?.status === 'active' ? 'Suspend this account?' : 'Reinstate this account?'}
        body={
          target?.status === 'active'
            ? 'They will be signed out everywhere and unable to use the product until reinstated.'
            : 'They will be able to sign in again.'
        }
        confirmLabel={target?.status === 'active' ? 'Suspend' : 'Reinstate'}
        danger={target?.status === 'active'}
        onCancel={() => setTarget(null)}
        onConfirm={() => target && suspend.mutate({ id: target.id, value: target.status === 'active' })}
      />
    </Card>
  );
}

function ReportsTab() {
  const qc = useQueryClient();
  const [active, setActive] = useState<ReportDto | null>(null);
  const [note, setNote] = useState('');

  const { data } = useQuery({ queryKey: ['admin', 'reports'], queryFn: () => api.get<ReportDto[]>('/admin/reports') });

  const resolve = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'actioned' | 'dismissed' }) =>
      api.post(`/admin/reports/${id}/resolve`, { status, note: note || undefined }),
    onSuccess: () => {
      setActive(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['admin', 'reports'] });
    },
  });

  if ((data ?? []).length === 0) return <EmptyState title="No reports" body="Nothing needs moderation right now." />;

  return (
    <Card>
      <Table head={['Reason', 'Status', 'Filed', 'Detail', '']}>
        {(data ?? []).map((r) => (
          <tr key={r.id} className="border-b border-line/60">
            <td className="py-2 pr-3">{titleCase(r.reason)}</td>
            <td className="py-2 pr-3">
              <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status}</Badge>
            </td>
            <td className="py-2 pr-3 text-ink-soft">{formatRelative(r.createdAt)}</td>
            <td className="max-w-[240px] truncate py-2 pr-3 text-ink-soft">{r.detail ?? '—'}</td>
            <td className="py-2">
              {r.status === 'open' && (
                <Button size="sm" variant="ghost" onClick={() => setActive(r)}>
                  Resolve
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>

      <Modal
        open={!!active}
        onClose={() => setActive(null)}
        title="Resolve report"
        footer={
          <>
            <Button variant="ghost" onClick={() => active && resolve.mutate({ id: active.id, status: 'dismissed' })}>
              Dismiss
            </Button>
            <Button loading={resolve.isPending} onClick={() => active && resolve.mutate({ id: active.id, status: 'actioned' })}>
              Mark actioned
            </Button>
          </>
        }
      >
        <p className="text-ink-soft">{active?.detail ?? 'No further detail provided.'}</p>
        <TextInput className="mt-3" label="Resolution note" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorNote error={resolve.error} />
      </Modal>
    </Card>
  );
}

function JobsTab() {
  const { data } = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => api.get<JobRowDto[]>('/admin/jobs'),
    refetchInterval: 5000,
  });
  return (
    <Card>
      <Table head={['Type', 'Status', 'Attempts', 'Run at', 'Last error']}>
        {(data ?? []).map((j) => (
          <tr key={j.id} className="border-b border-line/60">
            <td className="py-2 pr-3">{j.type}</td>
            <td className="py-2 pr-3">
              <Badge
                tone={
                  j.status === 'complete' ? 'success' : j.status === 'dead_letter' || j.status === 'failed' ? 'danger' : 'neutral'
                }
              >
                {j.status}
              </Badge>
            </td>
            <td className="py-2 pr-3">{j.attempts}</td>
            <td className="py-2 pr-3 text-ink-soft">{formatRelative(j.runAt)}</td>
            <td className="max-w-[260px] truncate py-2 text-ink-soft">{j.lastError ?? '—'}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function AuditTab() {
  const { data } = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => api.get<AuditEventDto[]>('/admin/audit') });
  return (
    <Card>
      <Table head={['Action', 'Target', 'Summary', 'When']}>
        {(data ?? []).map((e) => (
          <tr key={e.id} className="border-b border-line/60">
            <td className="py-2 pr-3 font-mono text-xs">{e.action}</td>
            <td className="py-2 pr-3 text-ink-soft">{e.targetType ?? '—'}</td>
            <td className="max-w-[260px] truncate py-2 pr-3 text-ink-soft">{e.summary ?? '—'}</td>
            <td className="py-2 text-ink-soft">{formatRelative(e.createdAt)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function MailboxTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['admin', 'emails'], queryFn: () => api.get<AdminEmailRow[]>('/admin/emails') });
  const { data: full } = useQuery({
    queryKey: ['admin', 'email', openId],
    queryFn: () => api.get<AdminEmailRow & { body: string }>(`/admin/emails/${openId}`),
    enabled: !!openId,
  });

  return (
    <Card>
      <p className="mb-3 text-sm text-ink-soft">
        Outgoing mail is captured here instead of being sent, so sign-in links work without an SMTP server.
      </p>
      <Table head={['To', 'Subject', 'Sent', '']}>
        {(data ?? []).map((m) => (
          <tr key={m.id} className="border-b border-line/60">
            <td className="py-2 pr-3">{m.toAddress}</td>
            <td className="py-2 pr-3">{m.subject}</td>
            <td className="py-2 pr-3 text-ink-soft">{formatRelative(m.createdAt)}</td>
            <td className="py-2">
              <Button size="sm" variant="ghost" onClick={() => setOpenId(m.id)}>
                Open
              </Button>
            </td>
          </tr>
        ))}
      </Table>

      <Modal open={!!openId} onClose={() => setOpenId(null)} title={full?.subject ?? 'Message'}>
        <pre className="ds-scroll max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-line/40 p-3 text-xs">
          {full?.body ?? '…'}
        </pre>
        {full?.link && (
          <Button className="mt-3" size="sm" onClick={() => (window.location.href = full.link!)}>
            Open the link
          </Button>
        )}
      </Modal>
    </Card>
  );
}
