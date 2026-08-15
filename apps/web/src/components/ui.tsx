import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/format';

/* ── Button ───────────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-dark disabled:bg-primary/50',
  secondary: 'bg-primary-soft text-ink hover:bg-primary-soft/70 disabled:opacity-50',
  ghost: 'bg-transparent text-ink-soft hover:bg-line/60 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      aria-busy={loading || undefined}
      disabled={rest.disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-5 py-2.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner size={14} className="border-current" />}
      {children}
    </button>
  );
}

/* ── Surfaces ─────────────────────────────────────────────────────────────── */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(43,35,32,0.04)]', className)}>
      {children}
    </div>
  );
}

type Tone = 'neutral' | 'primary' | 'warn' | 'success' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-line/70 text-ink-soft',
  primary: 'bg-primary-soft text-primary-dark',
  warn: 'bg-warn-soft text-warn',
  success: 'bg-accent/20 text-accent',
  danger: 'bg-red-100 text-red-700',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: Math.max(2, size / 9) }}
      className={cn('inline-block animate-spin rounded-full border-primary border-t-transparent align-[-2px]', className)}
    />
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card/60 px-6 py-10 text-center">
      <div className="mb-2 text-3xl" aria-hidden>
        🐾
      </div>
      <p className="font-medium text-ink">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-sm text-ink-soft">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ── Avatar & score ───────────────────────────────────────────────────────── */

export function Avatar({ src, alt, size = 48 }: { src?: string | null; alt: string; size?: number }) {
  if (!src) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-primary-soft text-lg"
        aria-hidden
      >
        🐾
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      className="shrink-0 rounded-full object-cover"
    />
  );
}

export function ScoreRing({ value, label, size = 56 }: { value: number; label?: string; size?: number }) {
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-center" title={label ? `${pct}% ${label}` : `${pct}% match`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${pct}% ${label ?? 'match'}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth="5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="fill-ink text-[13px] font-semibold">
          {pct}
        </text>
      </svg>
      {label && <span className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-soft">{label}</span>}
    </div>
  );
}

/* ── Inputs ───────────────────────────────────────────────────────────────── */

export function TextInput({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  const autoId = useRef(`in-${Math.random().toString(36).slice(2, 9)}`).current;
  const inputId = id ?? autoId;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full rounded-xl border border-line bg-white px-3 py-2.5 text-ink outline-none',
          'focus:border-primary focus:ring-2 focus:ring-primary/20',
          error && 'border-red-400',
          className,
        )}
      />
      {hint && !error && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  autoResize = true,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { autoResize?: boolean }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoResize || !ref.current) return;
    const el = ref.current;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [rest.value, autoResize]);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rest.rows ?? 2}
      className={cn(
        'w-full resize-none rounded-xl border border-line bg-white px-3 py-2.5 text-ink outline-none',
        'focus:border-primary focus:ring-2 focus:ring-primary/20',
        className,
      )}
    />
  );
}

export function Select({
  label,
  className,
  children,
  id,
  ...rest
}: InputHTMLAttributes<HTMLSelectElement> & { label?: string; children: ReactNode }) {
  const autoId = useRef(`sel-${Math.random().toString(36).slice(2, 9)}`).current;
  const selId = id ?? autoId;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={selId} className="mb-1 block text-sm font-medium text-ink">
          {label}
        </label>
      )}
      <select
        {...(rest as object)}
        id={selId}
        className={cn(
          'w-full rounded-xl border border-line bg-white px-3 py-2.5 text-ink outline-none',
          'focus:border-primary focus:ring-2 focus:ring-primary/20',
          className,
        )}
      >
        {children}
      </select>
    </div>
  );
}

/* ── Modal ────────────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard users land in the right place.
    panelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ds-scroll max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-line bg-card p-5 shadow-xl outline-none sm:rounded-3xl"
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full px-2 py-1 text-ink-soft hover:bg-line focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            ✕
          </button>
        </div>
        <div className="text-sm text-ink">{children}</div>
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/* ── Error surface ────────────────────────────────────────────────────────── */

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </p>
  );
}
