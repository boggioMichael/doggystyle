import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/format';
import type { ConnectionSummaryDto, MatchRequestDto } from '../lib/types';
import { Badge } from './ui';

const NAV = [
  { to: '/app', label: 'Chat', icon: '💬', end: true },
  { to: '/app/profile', label: 'Profile', icon: '🐕' },
  { to: '/app/intros', label: 'Intros', icon: '🤝', badge: 'intros' as const },
  { to: '/app/messages', label: 'Messages', icon: '✉️', badge: 'messages' as const },
  { to: '/app/meetups', label: 'Meetups', icon: '📅' },
];

export function Shell() {
  const { viewer, config, logout } = useAuth();

  const { data: intros } = useQuery({
    queryKey: ['introductions', 'incoming'],
    queryFn: () => api.get<MatchRequestDto[]>('/introductions?box=incoming'),
    refetchInterval: 15_000,
  });
  const { data: connections } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<ConnectionSummaryDto[]>('/connections'),
    refetchInterval: 15_000,
  });

  const counts = {
    intros: (intros ?? []).filter((i) => i.status === 'pending').length,
    messages: (connections ?? []).reduce((sum, c) => sum + c.unreadCount, 0),
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
      isActive ? 'bg-primary-soft text-primary-dark' : 'text-ink-soft hover:bg-line/60',
    );

  return (
    <div className="flex min-h-full flex-col">
      {config?.demoMode && (
        <div className="bg-primary-soft/70 px-4 py-1 text-center text-xs text-primary-dark">
          Demo mode — seeded neighbourhood data. You can simulate the other owner’s replies.
        </div>
      )}

      <header className="sticky top-0 z-20 border-b border-line bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
          <NavLink to="/app" className="flex items-center gap-1.5 font-semibold">
            <span aria-hidden>🐾</span>
            <span className="hidden sm:inline">{config?.brand.name ?? 'Doggystyle'}</span>
          </NavLink>

          <nav className="ml-auto hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
                {item.label}
                {item.badge && counts[item.badge] > 0 && (
                  <Badge tone="primary" className="px-1.5 py-0">
                    {counts[item.badge]}
                  </Badge>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1 md:ml-0">
            {viewer?.role === 'admin' && (
              <NavLink to="/app/admin" className={linkClass}>
                Admin
              </NavLink>
            )}
            <NavLink to="/app/settings" className={linkClass} aria-label="Settings">
              ⚙︎
            </NavLink>
            <button
              onClick={() => void logout()}
              className="rounded-full px-3 py-1.5 text-sm text-ink-soft hover:bg-line/60"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4 md:pb-8">
        <Outlet />
      </main>

      {/* Mobile tab bar */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-cream/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-3xl">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]',
                  isActive ? 'text-primary-dark' : 'text-ink-soft',
                )
              }
            >
              <span className="text-lg" aria-hidden>
                {item.icon}
              </span>
              {item.label}
              {item.badge && counts[item.badge] > 0 && (
                <span className="absolute right-1/4 top-1 h-2 w-2 rounded-full bg-primary" aria-hidden />
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
