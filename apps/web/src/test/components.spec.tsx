/**
 * Web unit tests — format utilities and UI components.
 *
 * These are pure-function and component-level tests that run in jsdom via Vitest.
 * They do not require a running server or database.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ageLabel,
  attributeSourceLabel,
  cn,
  formatAttributeValue,
  formatRelative,
  titleCase,
} from '../lib/format';
import { Button, Spinner } from '../components/ui';

/* ─── cn (class name helper) ────────────────────────────────────────────── */

describe('cn()', () => {
  it('joins truthy strings', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  it('skips falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });
  it('returns empty string when all falsy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});

/* ─── ageLabel ───────────────────────────────────────────────────────────── */

describe('ageLabel()', () => {
  it('returns "Age unknown" for null', () => {
    expect(ageLabel(null)).toBe('Age unknown');
  });
  it('returns "Age unknown" for undefined', () => {
    expect(ageLabel(undefined)).toBe('Age unknown');
  });
  it('converts fractional years < 1 to months', () => {
    expect(ageLabel(0.5)).toBe('6 months old');
  });
  it('uses "month" (singular) for exactly 1 month', () => {
    expect(ageLabel(1 / 12)).toBe('1 month old');
  });
  it('returns integer years without decimal', () => {
    expect(ageLabel(3)).toBe('3 years old');
  });
  it('uses "year" (singular) for 1', () => {
    expect(ageLabel(1)).toBe('1 year old');
  });
  it('rounds to 1 decimal place for fractional years >= 1', () => {
    expect(ageLabel(1.5)).toBe('1.5 years old');
  });
});

/* ─── titleCase ─────────────────────────────────────────────────────────── */

describe('titleCase()', () => {
  it('converts underscores to spaces and capitalises each word', () => {
    expect(titleCase('golden_retriever')).toBe('Golden Retriever');
  });
  it('handles already-spaced strings', () => {
    expect(titleCase('border collie')).toBe('Border Collie');
  });
  it('handles single words', () => {
    expect(titleCase('calm')).toBe('Calm');
  });
});

/* ─── attributeSourceLabel ───────────────────────────────────────────────── */

describe('attributeSourceLabel()', () => {
  it('maps known sources', () => {
    expect(attributeSourceLabel('user')).toBe('You');
    expect(attributeSourceLabel('vision_model')).toBe('Photos');
    expect(attributeSourceLabel('verified_document')).toBe('Verified');
    expect(attributeSourceLabel('social_import')).toBe('Import');
  });
  it('returns "Default" for unknown sources', () => {
    expect(attributeSourceLabel('unknown_source')).toBe('Default');
  });
});

/* ─── formatAttributeValue ───────────────────────────────────────────────── */

describe('formatAttributeValue()', () => {
  it('returns "—" for null', () => {
    expect(formatAttributeValue(null)).toBe('—');
  });
  it('returns "—" for undefined', () => {
    expect(formatAttributeValue(undefined)).toBe('—');
  });
  it('formats boolean true as "Yes"', () => {
    expect(formatAttributeValue(true)).toBe('Yes');
  });
  it('formats boolean false as "No"', () => {
    expect(formatAttributeValue(false)).toBe('No');
  });
  it('joins arrays with title-case and comma', () => {
    expect(formatAttributeValue(['calm', 'playful'])).toBe('Calm, Playful');
  });
  it('returns "—" for empty arrays', () => {
    expect(formatAttributeValue([])).toBe('—');
  });
  it('title-cases string values', () => {
    expect(formatAttributeValue('golden_retriever')).toBe('Golden Retriever');
  });
  it('rounds numbers to 2 decimal places', () => {
    expect(formatAttributeValue(3.14159)).toBe('3.14');
  });
});

/* ─── formatRelative ─────────────────────────────────────────────────────── */

describe('formatRelative()', () => {
  it('returns empty string for null', () => {
    expect(formatRelative(null)).toBe('');
  });
  it('returns "just now" for a very recent timestamp', () => {
    const now = new Date().toISOString();
    expect(formatRelative(now)).toBe('just now');
  });
  it('returns minutes ago for timestamps < 1 hour old', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelative(fiveMinAgo)).toBe('5m ago');
  });
  it('returns hours ago for timestamps < 1 day old', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(twoHoursAgo)).toBe('2h ago');
  });
});

/* ─── Button component ───────────────────────────────────────────────────── */

describe('<Button />', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeTruthy();
  });
  it('is disabled when the disabled prop is set', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('is disabled and aria-busy when loading', () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
  it('applies the danger variant class', () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('bg-red-600');
  });
});

/* ─── Spinner component ──────────────────────────────────────────────────── */

describe('<Spinner />', () => {
  it('renders without crashing', () => {
    const { container } = render(<Spinner size={24} />);
    expect(container.firstChild).toBeTruthy();
  });
});
