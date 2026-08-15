import { STARTER_PROMPTS } from '@doggystyle/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, TextArea } from '../components/ui';
import { useAuth } from '../lib/auth';

export const PENDING_PROMPT_KEY = 'ds_pending_prompt';

export default function Landing() {
  const { viewer, config } = useAuth();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');

  const brand = config?.brand.name ?? 'Doggystyle';
  const tagline = config?.brand.tagline ?? 'Tell us what you want for your dog. We do the rest.';

  /** Carry the typed objective across the sign-up wall so nothing is lost. */
  function go(text?: string) {
    const value = (text ?? prompt).trim();
    if (value) sessionStorage.setItem(PENDING_PROMPT_KEY, value);
    navigate(viewer ? '/app' : `/auth?mode=signup&next=${encodeURIComponent('/app')}`);
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-4">
        <span className="flex items-center gap-2 font-semibold">
          <span aria-hidden>🐾</span> {brand}
        </span>
        <Link to="/auth">
          <Button variant="ghost" size="sm">
            {viewer ? 'Open the app' : 'Sign in'}
          </Button>
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-5 py-10">
        <div className="text-center">
          <div className="text-5xl" aria-hidden>
            🐾
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">What would you like for your dog?</h1>
          <p className="mx-auto mt-3 max-w-md text-ink-soft">{tagline}</p>
        </div>

        <form
          className="mt-8"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                go();
              }
            }}
            rows={3}
            aria-label="What would you like for your dog?"
            placeholder="Find my dog an energetic playmate nearby this weekend..."
            className="text-base shadow-sm"
          />
          <div className="mt-3 flex justify-end">
            <Button type="submit">Send →</Button>
          </div>
        </form>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {STARTER_PROMPTS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => go(s.prompt)}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-primary hover:text-primary-dark"
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {[
            { n: '1', t: 'Connect your photos', d: 'A demo source, your own uploads, or an authorised export.' },
            { n: '2', t: 'We build the profile', d: 'Breed, age, energy and temperament — you just confirm it.' },
            { n: '3', t: 'Meet the right dogs', d: 'Ranked matches with reasons, then an introduction and a meetup.' },
          ].map((step) => (
            <div key={step.n} className="rounded-2xl border border-line bg-card p-4">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary-dark">
                {step.n}
              </span>
              <p className="mt-2 font-medium">{step.t}</p>
              <p className="mt-1 text-sm text-ink-soft">{step.d}</p>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
          <button onClick={() => go('Connect a photo source')} className="text-primary-dark underline-offset-2 hover:underline">
            Connect a photo source
          </button>
          <span className="text-line" aria-hidden>
            |
          </span>
          <button onClick={() => go('I want to upload photos instead')} className="text-primary-dark underline-offset-2 hover:underline">
            Upload photos instead
          </button>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-3xl px-5 py-6 text-center text-xs text-ink-soft">
        Adults only (18+). Your exact location is never shared with other owners.
      </footer>
    </div>
  );
}
