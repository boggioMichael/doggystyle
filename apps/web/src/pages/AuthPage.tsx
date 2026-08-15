import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, ErrorNote, Modal, Spinner, TextInput } from '../components/ui';
import { useAuth } from '../lib/auth';

type Mode = 'signin' | 'signup' | 'magic';

export default function AuthPage() {
  const { viewer, config, loading, login, signup, magicRequest, magicConsume } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/app';

  const [mode, setMode] = useState<Mode>(params.get('mode') === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [city, setCity] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  const token = params.get('token');

  // Arriving from a magic link: consume the token and go straight in.
  useEffect(() => {
    if (!token) return;
    (async () => {
      setBusy(true);
      try {
        await magicConsume(token);
        navigate(next, { replace: true });
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    })();
  }, [token, magicConsume, navigate, next]);

  useEffect(() => {
    if (!loading && viewer && !token) navigate(next, { replace: true });
  }, [viewer, loading, token, navigate, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await login(email, password);
        navigate(next, { replace: true });
      } else if (mode === 'signup') {
        await signup({
          email,
          password,
          displayName: displayName || undefined,
          city: city || undefined,
          ageConfirmed: true,
          acceptTerms: true,
        });
        navigate(next, { replace: true });
      } else {
        const res = await magicRequest(email);
        setSent(true);
        setDevLink(res.devLink ?? null);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (token && busy) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }

  const canSubmit =
    mode === 'magic'
      ? email.length > 3
      : mode === 'signin'
        ? email.length > 3 && password.length > 0
        : email.length > 3 && password.length >= 10 && ageConfirmed && acceptTerms;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-5 py-10">
      <Link to="/" className="mb-6 text-center text-2xl" aria-label="Home">
        🐾
      </Link>

      <Card>
        <div className="mb-4 flex rounded-full bg-line/50 p-1 text-sm">
          {(
            [
              ['signin', 'Sign in'],
              ['signup', 'Create account'],
              ['magic', 'Email me a link'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setMode(key);
                setError(null);
                setSent(false);
              }}
              className={`flex-1 rounded-full px-2 py-1.5 transition-colors ${
                mode === key ? 'bg-card font-medium text-ink shadow-sm' : 'text-ink-soft'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {sent ? (
          <div className="text-center">
            <p className="font-medium">Check your inbox</p>
            <p className="mt-1 text-sm text-ink-soft">If that address has an account, a sign-in link is on its way.</p>
            {devLink && (
              <Button className="mt-4" onClick={() => navigate(devLink.replace(window.location.origin, ''))}>
                Open sign-in link (demo)
              </Button>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <TextInput
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            {mode !== 'magic' && (
              <TextInput
                label="Password"
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint={mode === 'signup' ? 'At least 10 characters, with a letter and a number.' : undefined}
              />
            )}

            {mode === 'signup' && (
              <>
                <TextInput
                  label="Your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                />
                <TextInput
                  label="City"
                  list="ds-cities"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Tel Aviv"
                  hint="Used only to find dogs near you. Never shown precisely."
                />
                <datalist id="ds-cities">
                  {(config?.knownCities ?? []).map((c) => (
                    <option key={`${c.city}-${c.country}`} value={c.city} />
                  ))}
                </datalist>

                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ageConfirmed}
                    onChange={(e) => setAgeConfirmed(e.target.checked)}
                    className="mt-1"
                  />
                  <span>I confirm I am {config?.minimumAgeYears ?? 18} or older</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acceptTerms}
                    onChange={(e) => setAcceptTerms(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I accept the{' '}
                    <button type="button" onClick={() => setTermsOpen(true)} className="text-primary-dark underline">
                      terms and privacy summary
                    </button>
                  </span>
                </label>
              </>
            )}

            <Button type="submit" className="w-full" loading={busy} disabled={!canSubmit}>
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send me a link'}
            </Button>
            <ErrorNote error={error} />
          </form>
        )}
      </Card>

      <Modal open={termsOpen} onClose={() => setTermsOpen(false)} title="Terms & privacy — the short version">
        <ul className="space-y-2">
          <li>• You must be {config?.minimumAgeYears ?? 18} or older. This product arranges real-world meetings.</li>
          <li>• Your exact location is never shared. Other owners see a city and a rough distance only.</li>
          <li>• Photos you upload are re-encoded, which strips GPS and camera metadata.</li>
          <li>• Nobody can message you until you accept an introduction.</li>
          <li>• Health, genetic, pedigree and reproductive details are never guessed — only what you enter.</li>
          <li>• You can export or delete all of your data at any time from Settings.</li>
          <li>• Matching is a discovery tool, not veterinary or breeding advice.</li>
        </ul>
      </Modal>
    </div>
  );
}
