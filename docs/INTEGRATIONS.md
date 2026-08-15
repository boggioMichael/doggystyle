# Social / Media Integration Feasibility

Doggystyle treats every media source as an interchangeable `SocialProvider` adapter
(`apps/api/src/modules/social/providers/`). The whole product works end-to-end with **zero external
credentials** via the `demo`, `upload` and `archive` providers.

## Summary

| Provider | Adapter | Works today? | What's blocking |
| --- | --- | --- | --- |
| `demo` | `demoProvider.ts` | ✅ Yes | Nothing — simulates an authorised account with seeded media |
| `upload` | `uploadProvider.ts` | ✅ Yes | Nothing — direct file upload |
| `archive` | `archiveProvider.ts` | ✅ Yes | Nothing — user supplies their own platform data export (ZIP/JSON) |
| `instagram` | `instagramProvider.ts` | ⚙️ Code complete, disabled | Meta developer app + App Review (see below) |
| `google_photos` | `googlePhotosProvider.ts` | ⚙️ Code complete, disabled | Google Cloud project + OAuth consent screen verification |
| `facebook` | — | ❌ Not built | Same Meta app; `user_photos` is effectively unobtainable for new apps |

Enable a provider by setting its credentials in `.env`; `SOCIAL_PROVIDERS_ENABLED` is derived
automatically from which credentials are present.

---

## Instagram

**Reality check.** The old Instagram Basic Display API was **deprecated and shut down on
4 December 2024**. The remaining legitimate options are:

1. **Instagram API with Instagram Login** (`instagram_business_basic` scope) — works for
   *Business* and *Creator* accounts only. Returns media, captions, permalinks, media type,
   timestamps, username. Enough for our pipeline.
2. **Instagram API with Facebook Login** — requires the IG account to be linked to a Facebook Page.

Neither returns follower lists, other people's content, or anything about a *dog* specifically —
we derive that ourselves from images + captions in the media pipeline.

Personal (non-business) accounts have **no** supported media API. For those users we route to the
`archive` provider: Instagram's own **"Download your information"** export is a first-class,
platform-sanctioned path and our importer reads it directly.

### HUMAN ACTION REQUIRED — Instagram (optional; the product works without it)

**Reason:** Only you can create a Meta developer account, accept Meta's platform terms, and submit
the app for review. These are account/legal actions I cannot perform.

**Do this:**
1. Go to <https://developers.facebook.com/> and log in with your Facebook account.
2. Complete developer registration (accept the Meta Platform Terms and Developer Policies).
3. Click **My Apps → Create App**. Use case: **Other** → type: **Business**. Name it `Doggystyle Dev`.
4. In the app dashboard, add the product **Instagram** → **API setup with Instagram login**.
5. Under **Business login settings**, set:
   - OAuth redirect URI: `http://localhost:8080/api/social/instagram/callback`
   - Deauthorize callback URL: `http://localhost:8080/api/social/instagram/deauthorize`
   - Data deletion request URL: `http://localhost:8080/api/social/instagram/data-deletion`
6. Add yourself as an **Instagram Tester** (Roles → Instagram Testers) and accept the invite at
   <https://www.instagram.com/accounts/manage_access/>. Your own IG account must be switched to a
   **Business** or **Creator** account (Instagram app → Settings → Account type and tools).
7. For anything beyond your own tester account you must submit **App Review** for
   `instagram_business_basic`. That review is Meta's, not ours, and can take days.

**Give me:**
- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`

Paste them in chat and I will write them into `.env` myself — do not edit files.

---

## Google Photos

Since **31 March 2025** the Library API's broad read scopes are restricted: apps may only read media
**created by the app**, or media the user explicitly hands over through the **Google Photos Picker
API**. Our adapter uses the Picker API, which is the compliant path and requires no scary scopes.

### HUMAN ACTION REQUIRED — Google Photos (optional)

**Reason:** Creating a Google Cloud project, enabling APIs and configuring an OAuth consent screen
requires your Google account and acceptance of Google's terms.

**Do this:**
1. Open <https://console.cloud.google.com/> and create a project named `doggystyle-dev`.
2. **APIs & Services → Library** → enable **Photos Picker API**.
3. **APIs & Services → OAuth consent screen** → User type **External** → fill app name
   `Doggystyle`, your support email, developer email → add scope
   `https://www.googleapis.com/auth/photospicker.mediaitems.readonly` → add your own Google account
   under **Test users** (no verification needed while in Testing mode).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web
   application** → Authorised redirect URI:
   `http://localhost:8080/api/social/google_photos/callback`.

**Give me:**
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

---

## Facebook photos

`user_photos` permission is not granted to new apps for this kind of use case. **Decision: not
built.** Facebook users are routed to the `archive` provider (Facebook "Download your information"
export), which our archive importer already parses.

---

## Archive import (works today, no credentials)

Supported inputs:

- Instagram **Download your information** (JSON format) — reads `media.json` / `content/posts_1.json`
  and the `media/` folder.
- Facebook **Download your information** (JSON) — reads `posts/media/` and `your_photos.json`.
- Google **Takeout** for Photos — reads `.json` sidecars next to each image.
- A plain ZIP or folder of images — captions optional.

Safety limits applied on import: max 2 GB total uncompressed, max 5 000 entries, max 25 MB per
entry, zip-slip path rejection, image MIME verified by magic bytes.

---

## Adding a new provider

1. Implement `SocialProvider` in `apps/api/src/modules/social/providers/<name>Provider.ts`.
2. Register it in `providers/index.ts`.
3. Add credential env vars to `apps/api/src/config/env.ts` and `.env.example`.
4. Add a fixture-driven test in `apps/api/tests/social/<name>.spec.ts`.

No other layer needs to change — imports flow into the same `media_assets` + job pipeline.
