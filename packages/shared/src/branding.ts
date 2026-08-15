/**
 * Single source of truth for product branding.
 * Change the name here (or via BRAND_NAME / VITE_BRAND_NAME) and it changes everywhere.
 */

function envValue(key: string): string | undefined {
  // Works in Node (process.env) and in Vite (import.meta.env), without breaking either build.
  const nodeEnv =
    typeof process !== 'undefined' && process.env ? (process.env as Record<string, string | undefined>) : undefined;
  return nodeEnv?.[key] ?? nodeEnv?.[`VITE_${key}`];
}

export const BRAND = {
  name: envValue('BRAND_NAME') ?? 'Doggystyle',
  tagline: envValue('BRAND_TAGLINE') ?? 'Tell us what you want for your dog. We do the rest.',
  mark: '🐾',
  primaryPrompt: 'What would you like for your dog?',
  supportEmail: 'hello@doggystyle.local',
} as const;

export const STARTER_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: 'Find a walking buddy', prompt: 'Find my dog a friendly walking buddy nearby this weekend.' },
  { label: 'Find dogs nearby', prompt: 'Show me friendly dogs near us.' },
  { label: 'Arrange a playdate', prompt: 'Find my dog an energetic playmate nearby for a playdate.' },
  { label: 'Find a running partner', prompt: 'Find a dog that can keep up with him running.' },
  { label: 'Find a mating match', prompt: 'I want to find a suitable mating match for my dog.' },
  { label: 'Meet similar owners', prompt: 'Meet owners with dogs similar to mine.' },
];
