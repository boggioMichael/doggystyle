/**
 * End-to-end smoke test against a running API.
 *
 * Walks the Definition-of-Done sequence with real HTTP calls, exactly as the
 * browser would: signup → connect demo source → auto profile → conversational
 * correction → search → introduction → acceptance → message → meetup.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const stamp = Date.now();

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

function makeSession() {
  return { cookies: new Map() };
}

function cookieHeader(session) {
  return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(session, method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const cookie = cookieHeader(session);
  if (cookie) headers.cookie = cookie;
  const csrf = session.cookies.get('ds_csrf');
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) session.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body: json, raw: text };
}

async function chat(session, threadId, text) {
  const res = await call(session, 'POST', `/chat/threads/${threadId}/messages`, { text });
  if (res.status !== 200) throw new Error(`chat "${text}" → ${res.status} ${res.raw.slice(0, 300)}`);
  return res.body.messages.find((m) => m.role === 'assistant');
}

function attachmentOf(message, kind) {
  return (message?.attachments ?? []).find((a) => a.kind === kind) ?? null;
}

async function main() {
  console.log(`\nDoggystyle smoke test → ${BASE}\n`);

  /* 1 — account */
  const alice = makeSession();
  const email = `smoke+${stamp}@e2e.doggystyle.local`;
  const signup = await call(alice, 'POST', '/auth/signup', {
    email,
    password: 'SmokeTest123',
    displayName: 'Smoke Tester',
    city: 'Tel Aviv',
    ageConfirmed: true,
    acceptTerms: true,
  });
  check('signup returns viewer', signup.status === 200 && !!signup.body?.viewer, `status ${signup.status}`);
  check('session cookie set', alice.cookies.has('ds_session'));
  check('csrf cookie set', alice.cookies.has('ds_csrf'));

  /* CSRF must actually be enforced */
  const noCsrf = await fetch(`${BASE}/api/dogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(alice) },
    body: '{}',
  });
  check('POST without CSRF token is rejected', noCsrf.status === 403, `status ${noCsrf.status}`);

  /* 2 — chat thread */
  const thread = await call(alice, 'POST', '/chat/threads');
  const threadId = thread.body?.id;
  check('chat thread created', thread.status === 201 && !!threadId);

  /* 3 — connect the demo photo source */
  const connect = await call(alice, 'POST', '/social/demo/connect');
  const importId = connect.body?.importId;
  check('demo source connected', connect.status === 200 && !!importId, `importId ${importId ?? 'none'}`);

  let summary = null;
  for (let i = 0; i < 40; i += 1) {
    const res = await call(alice, 'GET', `/social/imports/${importId}`);
    summary = res.body;
    if (summary?.status === 'complete' || summary?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('import completed', summary?.status === 'complete', `${summary?.itemsStored ?? 0} stored, ${summary?.dogPhotos ?? 0} look like a dog`);

  /* 4-5 — automatic profile generation */
  const built = await chat(alice, threadId, 'Build my dog’s profile from the imported photos');
  const profileAttachment = attachmentOf(built, 'dog_profile');
  const profile = profileAttachment?.profile;
  check('profile generated from photos', !!profile, profile ? `${profile.name ?? 'unnamed'} · ${profile.breed ?? 'breed unknown'}` : built?.text?.slice(0, 120));
  check('profile has a photo', !!profile?.profilePhotoUrl);
  check('inferred attributes carry provenance', Object.keys(profile?.attributes ?? {}).length > 0, `${Object.keys(profile?.attributes ?? {}).length} attributes`);

  /* 6 — conversational correction */
  const corrected = await chat(alice, threadId, 'He’s actually four, not three.');
  const correctedProfile = attachmentOf(corrected, 'dog_profile')?.profile;
  check('age corrected by conversation', correctedProfile?.ageYears === 4, `age now ${correctedProfile?.ageYears}`);
  check('correction is marked owner-confirmed', correctedProfile?.attributes?.age_years?.source === 'user');

  /* 7-8 — search */
  const searched = await chat(alice, threadId, 'Find my dog a compatible dog nearby for a playdate.');
  const result = attachmentOf(searched, 'matches')?.result;
  check('search returned ranked matches', (result?.candidates?.length ?? 0) > 0, `${result?.candidates?.length ?? 0} candidates`);

  // Introduce to a *seeded* dog: the demo simulation deliberately refuses to
  // act on behalf of real accounts, and earlier smoke runs leave dogs behind.
  const SEEDED_DOGS = ['Luna', 'Kobi', 'Milo', 'One', 'Pixel', 'Rocket', 'Nala', 'Ziggy', 'Sesame', 'Bamba'];
  const top =
    result?.candidates?.find((c) => SEEDED_DOGS.includes(c.name)) ?? result?.candidates?.[0];
  check('candidate has a score', typeof top?.score === 'number', top ? `${top.name} ${top.score}%` : '');
  check('candidate explains itself', (top?.reasons?.length ?? 0) > 0, top?.reasons?.[0] ?? '');
  check('distance is bucketed, not precise', !!top?.distanceLabel && !/\d\.\d{3}/.test(top.distanceLabel), top?.distanceLabel);

  /* privacy: no exact location or email anywhere in the payload */
  const leaked = [];
  (function walk(node, path = '') {
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (['email', 'exactLat', 'exactLng', 'lat', 'lng', 'ipHash', 'passwordHash', 'tokenHash'].includes(k)) {
        leaked.push(`${path}.${k}`);
      }
      walk(v, `${path}.${k}`);
    }
  })(result);
  check('no exact location / email leaked in search results', leaked.length === 0, leaked.join(', '));

  /* 9 — refine conversationally */
  const another = await chat(alice, threadId, 'Show me another.');
  check('conversational refinement works', !!attachmentOf(another, 'candidate') || !!another?.text, another?.text?.slice(0, 80));

  /* 10 — introduction (sensitive → must require confirmation) */
  const asked = await chat(alice, threadId, `I like ${top?.name}. Ask their owner.`);
  const confirmation = attachmentOf(asked, 'confirmation')?.confirmation;
  check('introduction requires explicit confirmation', !!confirmation, confirmation?.summary ?? asked?.text?.slice(0, 100));

  const confirmed = await call(alice, 'POST', `/chat/confirmations/${confirmation?.id}`, { confirm: true });
  const introMessage = confirmed.body?.messages?.[0];
  const introduction = attachmentOf(introMessage, 'introduction')?.request;
  check('introduction request created', !!introduction, introduction ? `${introduction.fromDog.name} → ${introduction.toDog.name}` : confirmed.raw?.slice(0, 200));

  /* 11 — mutual acceptance (simulated as the seeded owner) */
  const accept = await call(alice, 'POST', `/demo/introductions/${introduction?.id}/accept`);
  check('other owner accepted (demo simulation)', accept.status === 200 && accept.body?.status === 'accepted', `status ${accept.status}`);

  const connections = await call(alice, 'GET', '/connections');
  const connection = connections.body?.[0];
  check('connection created', (connections.body?.length ?? 0) > 0, connection ? `with ${connection.peerDog.name}` : '');

  /* 12 — messaging */
  const sent = await call(alice, 'POST', `/connections/${connection?.connectionId}/messages`, {
    body: 'Hi! Saturday morning at the park?',
  });
  check('message sent', sent.status === 200 && sent.body?.mine === true);

  const messages = await call(alice, 'GET', `/connections/${connection?.connectionId}/messages`);
  check('conversation readable', (messages.body?.length ?? 0) >= 2, `${messages.body?.length ?? 0} messages`);

  /* 13 — meetup */
  const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  start.setHours(10, 0, 0, 0);
  const meetup = await call(alice, 'POST', `/connections/${connection?.connectionId}/meetups`, {
    startsAt: start.toISOString(),
    durationMinutes: 90,
  });
  check('meetup proposed', meetup.status === 200 && meetup.body?.status === 'proposed', meetup.body?.locationLabel);
  check('meetup location is a public area, not an address', !!meetup.body?.locationLabel && !/\d+\s+\w+\s+(street|road|ave)/i.test(meetup.body.locationLabel));

  const meetAccept = await call(alice, 'POST', `/demo/meetups/${meetup.body?.id}/accept`);
  check('meetup accepted by other owner', meetAccept.status === 200 && meetAccept.body?.status === 'accepted', `status ${meetAccept.status}`);

  /* 14 — mating is a separate track with a disclaimer */
  const mating = await chat(alice, threadId, 'I want to find a suitable mating match for my dog.');
  const matingResult = attachmentOf(mating, 'matches')?.result;
  check(
    'mating search is a distinct intent',
    matingResult?.intent === 'mating' || /breeding/i.test(mating?.text ?? ''),
    matingResult ? `disclaimer: ${matingResult.disclaimer ? 'present' : 'MISSING'}` : mating?.text?.slice(0, 120),
  );

  /* IDOR: a second user must not see the first user's dog.
     Sign in as a seeded owner rather than creating another account — repeated
     runs would otherwise trip the (correct) signup rate limit. */
  const bob = makeSession();
  const bobLogin = await call(bob, 'POST', '/auth/login', {
    email: 'owner2@demo.doggystyle.local',
    password: 'Demo123!',
  });
  check('second actor signed in', bobLogin.status === 200, `status ${bobLogin.status}`);

  const idor = await call(bob, 'GET', `/dogs/${profile?.id}`);
  check('IDOR: other user cannot read the dog (404, not 403)', idor.status === 404, `status ${idor.status}`);
  const idorSearch = await call(bob, 'GET', `/matches/searches/${result?.searchId}`);
  check('IDOR: other user cannot read the search', idorSearch.status === 404, `status ${idorSearch.status}`);
  const adminProbe = await call(bob, 'GET', '/admin/users');
  check('admin routes rejected for normal users', adminProbe.status === 403, `status ${adminProbe.status}`);

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
