import type { ReactNode } from 'react';
import { Navigate, createBrowserRouter, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useAuth } from './lib/auth';
import { Spinner } from './components/ui';
import AdminPage from './pages/AdminPage';
import AuthPage from './pages/AuthPage';
import ChatPage from './pages/ChatPage';
import IntrosPage from './pages/IntrosPage';
import Landing from './pages/Landing';
import MeetupsPage from './pages/MeetupsPage';
import MessagesPage from './pages/MessagesPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { viewer, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }
  if (!viewer) {
    return <Navigate to={`/auth?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

export const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/auth', element: <AuthPage /> },
  {
    path: '/app',
    element: (
      <RequireAuth>
        <Shell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <ChatPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'intros', element: <IntrosPage /> },
      { path: 'messages', element: <MessagesPage /> },
      { path: 'messages/:connectionId', element: <MessagesPage /> },
      { path: 'meetups', element: <MeetupsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
