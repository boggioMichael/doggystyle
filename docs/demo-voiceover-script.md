# Doggystyle – Demo Voice-Over Script

> **Usage:** Read aloud at a calm, conversational pace (~130 wpm).  
> Each section maps to a moment in `demo-video.spec.ts`.  
> Pauses marked **[beat]** = 1–2 s silence; **[long beat]** = 2–3 s.  
> Total narrated runtime: ~2 min 30 s.

---

## 🎵 Music note
Suggested track style: **warm acoustic guitar loop** (Pixabay "Coffee Chill" or similar CC0 track).  
Start at ~20% volume under narration; bring up slightly during silent transitions.  
Fade out over the final 5 seconds.

---

## Scene 1 — Landing page
*(Camera: full-page landing, prompt box centred)*

> "Your dog wants to meet someone.  
> Doggystyle starts where every dog walk ends —  
> with a single question."

**[beat]**

---

## Scene 2 — Typing the first message
*(Camera: owner types into the prompt box)*

> "No forms. No filters to configure.  
> Just tell us what you're looking for — the way you'd say it to a friend."

**[beat]**

---

## Scene 3 — Sign-up wall
*(Camera: auth form appears, owner fills it in)*

> "Doggystyle is invite-only for now,  
> so we need one quick account.  
> Your original request carries across — you won't lose it."

**[beat]**

---

## Scene 4 — Connecting a photo source
*(Camera: 'Use demo source' button appears in the chat)*

> "Connect the place your dog photos already live —  
> Google Photos, Instagram, or upload directly.  
> We'll do the rest."

**[beat]**

---

## Scene 5 — Media pipeline running
*(Camera: progress indicator, 'Imported N photos' message appears)*

> "Every photo goes through a computer-vision pipeline:  
> classify, cluster, score.  
> We find the frames where your dog is the star,  
> and we remember where each fact came from."

**[long beat]**

---

## Scene 6 — Auto-generated profile
*(Camera: rich profile card scrolls into view — breed, age, traits)*

> "From those photos, Doggystyle builds a complete profile:  
> breed, estimated age, energy level, size — all with provenance.  
> You can see exactly which photo backed each inference."

**[beat]**

---

## Scene 7 — Conversational correction
*(Camera: owner types "He's actually four, not three.")*

> "The AI won't always be right.  
> That's fine — just correct it in plain language,  
> the same way you'd correct anyone."

**[long beat]**

*(Camera: profile updates inline)*

> "The profile updates immediately.  
> No separate edit screen. No save button."

**[beat]**

---

## Scene 8 — Asking for matches
*(Camera: owner types 'Find my dog a compatible dog nearby for a playdate.')*

> "When you're ready, ask for matches —  
> also in plain language."

**[beat]**

---

## Scene 9 — Ranked results with reasons
*(Camera: match cards scroll up, each with a 'Why' reason)*

> "Results are ranked by compatibility —  
> energy, size, breed temperament, proximity.  
> Every recommendation comes with a plain-English reason,  
> not just a percentage."

**[long beat]**

---

## Scene 10 — Introduction request
*(Camera: owner clicks 'Ask their owner')*

> "Found a good match?  
> You can ask for an introduction —  
> but only with one explicit click.  
> Doggystyle never sends a request on your behalf without confirmation."

**[beat]**

---

## Scene 11 — Mutual acceptance
*(Camera: Introductions page, 'Simulate their owner accepting')*

> "The other owner gets a request notification.  
> Both sides must accept before anything happens —  
> no one-sided contact, ever."

**[long beat]**

---

## Scene 12 — Messaging
*(Camera: Messages page, thread opens, owner types 'Hi! Saturday morning at the park?')*

> "Once you're mutually connected, the conversation moves here —  
> a simple, private message thread between two real owners."

**[beat]**

---

## Scene 13 — Proposing a meetup
*(Camera: meetup card appears with location and time)*

> "Propose a meetup with a time and a public place.  
> No home addresses. No exact coordinates.  
> Just the park, and a time."

**[beat]**

---

## Scene 14 — End card
*(Camera: slow fade to Doggystyle wordmark)*

> "Doggystyle — because your dog deserves a social life too.  
> Beta is open.  
> [your-url-here]"

**[music swells gently, then fades]**

---

## Recording tips

- **Microphone distance:** 15–20 cm; pop filter recommended.
- **Room:** quiet room, record in a wardrobe or soft-furnished space to avoid reverb.
- **Pace:** read slowly — the video is the story, your voice is the guide.
- **Editing:** in DaVinci Resolve or CapCut, align each narration clip to the start of its matching scene.
- **ffmpeg merge (once you have `voiceover.mp3` and `music.mp3`):**

```bash
ffmpeg -i artifacts/demo/doggystyle-demo.mp4 \
       -i voiceover.mp3 \
       -i music.mp3 \
  -filter_complex \
    "[2:a]volume=0.12,afade=t=out:st=145:d=5[bg]; \
     [1:a][bg]amix=inputs=2:normalize=0[mix]" \
  -map 0:v \
  -map "[mix]" \
  -c:v copy \
  -c:a aac -b:a 192k \
  -shortest \
  artifacts/demo/doggystyle-demo-narrated.mp4
```

- Adjust `st=145` (fade-out start in seconds) to match your actual video length.
- If the voice-over is louder than the music, raise/lower `volume=0.12` accordingly.
