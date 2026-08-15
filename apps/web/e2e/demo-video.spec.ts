import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, uniqueEmail } from './helpers';

/**
 * The narrated product walkthrough, recorded as a video.
 *
 * This is not a test of correctness (critical-path.spec.ts does that) — it is
 * the choreography for a watchable demo, so explicit pauses are intentional.
 * Run with:  npx playwright test --project=demo-video
 */

const OUT_DIR = path.resolve(process.cwd(), '../../artifacts/demo');

test('Doggystyle product walkthrough', async ({ page }) => {
  test.setTimeout(300_000);
  const beat = (ms = 1400) => page.waitForTimeout(ms);
  const email = uniqueEmail('demo');

  /* 1 — The landing page: one prompt box, nothing else. */
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /what would you like for your dog/i })).toBeVisible();
  await beat(2200);

  /* 2 — Type an objective, exactly as a real owner would. */
  const prompt = page.getByLabel('What would you like for your dog?');
  await prompt.click();
  await prompt.pressSequentially('Find my dog an energetic playmate nearby this weekend', { delay: 45 });
  await beat(1200);
  await page.getByRole('button', { name: 'Send →' }).click();

  /* 3 — Sign up. The objective is carried across the wall. */
  await page.waitForURL('**/auth**');
  await beat(900);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Your name').fill('Sam');
  await page.getByLabel('City').fill('Tel Aviv');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('checkbox').nth(1).check();
  await beat(800);
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.waitForURL('**/app**', { timeout: 30_000 });
  await beat(2400);

  /* 4 — Connect a photo source. */
  const demoButton = page.getByRole('button', { name: /use demo source/i }).first();
  await demoButton.waitFor({ timeout: 30_000 });
  await beat(1200);
  await demoButton.click();

  /* 5 — The media pipeline runs: classify, cluster, score, pick a face. */
  await expect(page.getByText(/Imported \d+ photo/)).toBeVisible({ timeout: 90_000 });
  await beat(2600);

  /* 6 — Build the profile from those photos. */
  const build = page.getByRole('button', { name: /build the profile from these/i }).first();
  if (await build.count()) {
    await beat(1000);
    await build.click();
  }
  // The proposed profile, with provenance on every inferred field.
  await expect(page.getByRole('button', { name: /looks right/i }).first()).toBeVisible({ timeout: 90_000 });
  await page.mouse.wheel(0, 500);
  await beat(3000);

  /* 7 — Correct it in plain language. */
  const composer = page.getByLabel('Message');
  await composer.click();
  await composer.pressSequentially('He’s actually four, not three.', { delay: 40 });
  await beat(700);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await beat(3200);
  await page.mouse.wheel(0, 600);
  await beat(1800);

  /* 8 — Ask for matches. */
  await composer.click();
  await composer.pressSequentially('Find my dog a compatible dog nearby for a playdate.', { delay: 35 });
  await beat(700);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  /* 9 — Ranked results with reasons, inline in the conversation. */
  await expect(page.getByText('Why').first()).toBeVisible({ timeout: 60_000 });
  await beat(2600);
  await page.mouse.wheel(0, 700);
  await beat(2600);

  /* 10 — Request an introduction. Sensitive, so it needs a human click.
     Target a seeded owner: the demo "simulate acceptance" control deliberately
     refuses to act on behalf of a real account. */
  const seeded = ['Milo', 'Luna', 'Kobi', 'Nala', 'Bamba', 'Rocket', 'Pixel', 'Sesame', 'Ziggy', 'One'];
  let ask = page.getByRole('button', { name: /ask their owner/i }).first();
  for (const name of seeded) {
    const card = page.locator('div', { has: page.getByRole('heading', { name, exact: true }) });
    const button = card.getByRole('button', { name: /ask their owner/i }).first();
    if (await button.count()) {
      ask = button;
      break;
    }
  }
  await ask.scrollIntoViewIfNeeded();
  await beat(1200);
  await ask.click();
  await beat(2400);

  /* 11 — Mutual consent: simulate the other owner accepting. */
  await page.goto('/app/intros');
  await beat(1400);
  await page.getByRole('button', { name: /outgoing/i }).click();
  await beat(1400);
  const simulate = page.getByRole('button', { name: /simulate their owner accepting/i }).first();
  if (await simulate.count()) {
    await simulate.click();
    await beat(2600);
  }

  /* 12 — Message the other owner. */
  await page.goto('/app/messages');
  await beat(1600);
  const firstConversation = page.locator('button', { hasText: /Say hello|park|walk/ }).first();
  if (await firstConversation.count()) {
    await firstConversation.click();
    await beat(1400);
    const messageBox = page.getByLabel('Message').last();
    await messageBox.click();
    await messageBox.pressSequentially('Hi! Saturday morning at the park?', { delay: 40 });
    await beat(700);
    await page.getByRole('button', { name: 'Send', exact: true }).last().click();
    await beat(2200);

    /* 13 — Arrange the meetup. */
    await page.getByRole('button', { name: 'Meetup' }).click();
    await beat(1800);
    await page.getByRole('button', { name: 'Propose' }).click();
    await beat(2600);
  }

  /* 14 — The meetup, with a public place suggested halfway between owners. */
  await page.goto('/app/meetups');
  await beat(1600);
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.click();
    await beat(1200);
  }
  const simulateMeetup = page.getByRole('button', { name: /simulate their owner accepting/i }).first();
  if (await simulateMeetup.count()) {
    await simulateMeetup.click();
    await beat(2600);
  }

  /* 15 — The profile page: provenance, confidence, confirmation. */
  await page.goto('/app/profile');
  await beat(2400);
  await page.mouse.wheel(0, 900);
  await beat(3000);
  await page.mouse.wheel(0, 900);
  await beat(3000);
});

test.afterAll(async () => {
  // Playwright finalises the video on context close; copy it somewhere findable.
  mkdirSync(OUT_DIR, { recursive: true });
});

test.afterEach(async ({ page }, testInfo) => {
  const video = page.video();
  if (!video) return;
  await page.context().close();
  const source = await video.path();
  mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, 'doggystyle-demo.webm');
  try {
    copyFileSync(source, target);
    // eslint-disable-next-line no-console
    console.log(`\n🎬 Demo video: ${target}\n`);
    testInfo.attach('demo-video', { path: target, contentType: 'video/webm' }).catch(() => {});
  } catch {
    /* the runner will still keep it under test-results/ */
  }
});
