<div align="center">

# 🐾 Doggystyle

**Tell us what you want for your dog. We do the rest.**

</div>

---

## What it is

Doggystyle is a conversational service for dog owners. Instead of filling in a twenty-field profile
and swiping through photos, you type what you actually want:

> *"Find my dog a calm walking buddy nearby this weekend."*
> *"I want to find a suitable mating match for my Golden Retriever."*
> *"Find dogs around my dog's age that like energetic play."*

The system builds your dog's profile for you from photos you already have, finds genuinely compatible
dogs, tells you **why** it picked them, and helps you arrange the meetup — all inside one chat box.

## Why it exists

Every dog-social product fails the same three ways:

| Problem | What happens | What Doggystyle does |
| --- | --- | --- |
| Profile creation is a chore | Sparse, stale profiles; nobody finishes onboarding | The system **proposes** a full profile from your photos; you just confirm or correct it |
| Matching is appearance-first swiping | Mismatched energy levels, bad meetups, churn | Deterministic matching on **activity, play style, size, temperament, schedule** — with the reasoning shown |
| Coordination happens off-platform | No feedback loop, no network effects | Introductions, messaging and meetup scheduling all live in the product |

## The customer experience

The whole product is one prompt box. Everything else appears *inside the conversation*.

```
┌──────────────────────────────────────────────┐
│                 🐾 Doggystyle                │
│                                              │
│       What would you like for your dog?      │
│                                              │
│   ┌────────────────────────────────────────┐ │
│   │ Find my dog an energetic playmate      │ │
│   │ nearby this weekend...                 │ │
│   └────────────────────────────────────────┘ │
│                                     Send →   │
│                                              │
│   Find a walking buddy · Find dogs nearby    │
│   Arrange a playdate · Find a mating match   │
└──────────────────────────────────────────────┘
```

### The journey, end to end

1. **Sign up** — email + password, or a passwordless sign-in link. Nothing else asked.
2. **Connect a photo source** — a demo source, a direct upload, or an authorised platform export.
   No scraping, no passwords, no browser automation. (See [Integrations](docs/INTEGRATIONS.md).)
3. **The system finds your dog** — photos are classified, grouped per-dog, scored for quality, and
   the best shot becomes the profile picture.
4. **A complete profile appears** — breed, age, size, energy, play style, temperament, interests.
   Every field shows where it came from and how confident the system is.
5. **You correct it by talking** — *"He's actually four, not three."* · *"Remove that second picture."*
   · *"He's friendly with small dogs but nervous around large ones."* · *"We moved to Haifa."*
6. **You state a goal** — *"Find my dog a compatible dog nearby for a playdate."*
7. **Ranked matches appear inline**, each with a score, a distance, concise reasons, and any conflicts:

   ```
   Milo — 91% match
   2-year-old Border Collie · ~4 km away

   Why:
   • Similar activity level
   • Both enjoy long outdoor walks
   • Owners are usually free Friday mornings
   • Compatible play style

   Heads up:
   • Milo is slightly larger than your preferred range
   ```

8. **You refine, still by talking** — *"Show me another."* · *"Only dogs closer than this."*
   · *"I like Milo. Ask his owner."*
9. **Introductions are mutual.** Nobody is ever committed to meeting a stranger automatically. The
   other owner sees why the dogs look compatible, and can accept, decline, or ask a question.
10. **Then you message and arrange a meetup** — *"Something Saturday afternoon, roughly halfway
    between us."* The suggested spot is a public place near the midpoint; nobody's address is shared.

### Two things it deliberately does *not* do

- **It never invents facts about your dog.** Breed and energy level can be inferred from photos and
  captions. Health, genetics, pedigree, vaccination and reproductive status **cannot** — those stay
  blank until you enter them. This is enforced by a database constraint, not just by convention.
- **It never presents a mating match as breeding approval.** Mating is a separate, explicit search
  mode that reports *what information exists* about a candidate rather than an AI compatibility
  score, with a standing disclaimer that it is a discovery tool and not veterinary advice.

### Privacy, by design

Your exact location is never sent to another user — not in an API response, not in a distance, not in
a photo's metadata. Distances are bucketed, coordinates are snapped to a ~1 km grid, uploaded images
are re-encoded to strip EXIF/GPS, and meetup locations are only revealed after both owners agree.

---

## Status

🚧 **Under active construction.** This README will grow the setup, launch, testing and troubleshooting
sections as the stack lands. Architecture and design decisions are already written down:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — stack, module map, data model, diagrams
- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product requirements and user journeys
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — STRIDE analysis and safety decisions
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) — what each social/media provider can actually do
- [`docs/adr/`](docs/adr/) — architecture decision records
