import { expect, type Page } from '@playwright/test';

export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}+${Date.now()}${Math.floor(Math.random() * 1000)}@e2e.doggystyle.local`;
}

export const E2E_PASSWORD = 'E2ePassword123';

/** Seeded demo owners — see apps/api/src/seed/data.ts. */
export const DEMO_OWNERS = {
  milo: { email: 'owner3@demo.doggystyle.local', password: 'Demo123!', dog: 'Milo' },
  luna: { email: 'owner1@demo.doggystyle.local', password: 'Demo123!', dog: 'Luna' },
} as const;

export async function signup(page: Page, email: string, name = 'E2E Tester'): Promise<void> {
  await page.goto('/auth?mode=signup');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('City').fill('Tel Aviv');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.waitForURL('**/app**', { timeout: 30_000 });
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await page.waitForURL('**/app**', { timeout: 30_000 });
}

/** Send a chat message and wait for the assistant's reply to land. */
export async function sendChat(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('msg-assistant').count();
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() => page.getByTestId('msg-assistant').count(), { timeout: 60_000 })
    .toBeGreaterThan(before);
}

/** Waits for the import card to finish polling. */
export async function waitForImport(page: Page): Promise<void> {
  await expect(page.getByText(/Imported \d+ photo/)).toBeVisible({ timeout: 90_000 });
}
