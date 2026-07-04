# Tragedy of the Comments — Build Log

Append-only build/QA log, same convention as Polarity, the Jeopardy game, and Geopostor.

## Session 1 — Initial build

### Stack decision
Built as vanilla JS + Firebase, hosted static, matching the rest of this
ecosystem. Originally scaffolded against Firebase Realtime Database (the
Polarity pattern), then switched to **Firestore** partway through once the
user supplied a Firestore-shaped config (`tragedy-of-the-commons-4e239`,
no `databaseURL`). The Firestore SDK is loaded via the gstatic CDN modular
build (not an npm import) to keep this a zero-build static site.

### Files added
| File | Purpose |
|---|---|
| `index.html` / `js/landing.js` | Landing page — create room / join room |
| `lobby.html` / `js/lobby.js` | Real-time lobby, host start-game control |
| `game.html` / `js/game.js` | Single-page phase router driven by `room.status` |
| `js/submission.js` | Submission phase: link slots, soft timer, live validation, close-and-compile |
| `js/presenter.js` | Host compiled-list presenter (prev/next, attribution toggle, start voting) |
| `js/voting.js` | Point-weighted ballot phase |
| `js/reveal.js` | Ranked-choice reveal animation + round-loop trigger |
| `js/linkValidation.js` | TikTok/Instagram format validation + TikTok oEmbed resolution |
| `js/scoring.js` | Pure functions: merge submissions, tally weighted results |
| `js/firebase.js` | Firestore data layer (rooms, players, rounds, submissions, ballots) |
| `js/config.js` | Game name/tagline + all tunable constants |
| `css/style.css` | Placeholder functional styling per brief |
| `firestore.rules`, `firebase.json` | Open dev rules scoped to `rooms/{code}` + hosting config |
| `serve.js` | Minimal local static server for QA (avoids npm/npx on this machine) |

### Platform constraints flagged (not oversights)
- **TikTok oEmbed** (`https://www.tiktok.com/oembed`) sends `Access-Control-Allow-Origin: *`
  on success — confirmed via direct curl test — so it's callable straight from
  browser JS. It resolves short links, returns a canonical video ID
  (`embed_product_id`), a thumbnail, and errors on a dead video. One call
  covers format validation, liveness resolution, canonicalization, and
  thumbnail for TikTok links.
- **Instagram's oEmbed** now requires a Meta Graph API access token and sends
  no CORS headers for anonymous requests (also confirmed via curl — redirects
  to a 301 with no ACAO header). There is no client-only way to verify an
  Instagram Reels link is alive or fetch its thumbnail. Instagram links are
  therefore format-validated only (regex + shortcode extraction) and accepted
  without a liveness check or thumbnail. Surfaced in the UI as "format valid
  — Instagram can't be auto-verified."
- **Score persistence across rounds**: stubbed as an off-by-default toggle
  (`PERSIST_SCORES_ACROSS_ROUNDS` in `config.js`) with the write path already
  implemented in `firebase.js` (`applyRoundResultsToScores`) but never called
  — flip the constant and wire the call in `reveal.js` if wanted later.
- **Disconnect cleanup**: Firestore has no `onDisconnect` primitive like
  Realtime Database. `armDisconnectCleanup`/`cancelDisconnectCleanup` are
  intentional no-ops with a comment explaining why — a disconnected player
  just stays listed, which is harmless for a short, host-supervised game.

### QA — in progress (this session)
Ran the app against the live Firestore project via a local static server
(`node serve.js`, port 8080) and a two-tab browser session (host + guest).

**Confirmed working end to end:**
- Room create/join, real-time lobby sync, round start
- Link validation: valid TikTok (oEmbed round trip), a deliberately broken
  TikTok video ID (correctly surfaced as "This link didn't work — try
  another"), Instagram format-valid-but-unverifiable link, and the
  edit-and-revalidate replacement flow
- Soft timer counts down, turns red under 10s, does **not** lock submission
  at zero
- Duplicate detection/merge: two players submitting the same TikTok video
  collapsed into one entry with both names and a correct 2x weight multiplier
- Host presenter view: prev/next navigation, attribution toggle (synced),
  thumbnail rendering
- Voting: budget tracking, over-budget correctly blocks submission, and a
  player is correctly barred from voting on entries they contributed to
  (including as part of a merged entry)
- Reveal animation: tally count-up, lowest-to-highest reveal order, winner
  emphasis, correct weighted math (verified by hand: merged entry got 0 raw
  votes → 0 weighted; two solo entries at 4 and 6 raw points ranked #2/#1)
- Round loop: "Start next round" resets timer, link slots, and submission
  counts correctly

**Bugs found and fixed this session:**
1. Presenter thumbnails had no height cap — a portrait TikTok thumbnail
   (576x1024) rendered near full width pushed all the presenter controls off
   screen. Fixed with `max-height: 420px` + `object-fit: contain` in
   `css/style.css`.
2. Async host action buttons (create/join room, start game, close
   submissions, start voting, reveal results, start next round) gave no
   loading feedback, which looked broken under this machine's network
   latency (Firestore writes on this box are slow — see note below). Added
   disabled + "...ing" label states across `landing.js`, `lobby.js`,
   `submission.js`, `presenter.js`, `voting.js`.
3. **Self-inflicted regression while fixing #2**: the loading-state flags for
   `close-submissions-btn`, `start-voting-btn`, and `reveal-results-btn` were
   set on click but never reset, so on round 2 those buttons would have
   stayed permanently stuck disabled/relabeled from round 1's click (only
   masked in testing by an incidental full page reload between rounds 1 and
   2). Fixed by resetting each button's disabled/label state whenever its
   phase module detects a new round number, matching the reset pattern
   `submission.js` already used for the timer and link slots.
4. Not a code bug, but worth recording: writes on this dev machine took
   several seconds longer than they should (a plain `updateDoc` completed in
   ~465ms, but `writeBatch` commits and cold Firestore Listen-channel setup
   took multiple seconds). Likely related to this machine's Norton TLS
   interception forcing Firestore's SDK into its long-polling fallback
   transport instead of native streaming (see `npm_norton_tls` memory note
   about the same box). Not something to fix in app code; the loading-state
   fix in #2 is the mitigation.

### QA — closed out

Re-tested the fix for item 3 by reloading both tabs and playing through
rounds 2 and 3 back to back with no reload in between (the exact scenario
the earlier fix targeted). Confirmed on round 3:
- "Close submissions & compile" rendered fresh and enabled (not stuck on
  "Compiling..." from round 2's click)
- "Start voting" rendered fresh and enabled
- "Reveal results" rendered fresh and enabled
- Timer, link slots, and submission counts all reset correctly a second time

Also reconfirmed the reveal math on round 2's single-entry case (0 votes
possible since the only contributor was also the only other player, correctly
showing 0 pts) and that both host and guest tabs stayed in sync into round 3
in real time.

No further issues found on this pass. QA phase is clean.

**Intentionally deferred (not bugs, scope calls):**
- Score persistence across rounds — stubbed behind `PERSIST_SCORES_ACROSS_ROUNDS`
  in `config.js`, off by default, per the brief's "flag your choice" ask.
- Instagram Reels liveness verification and thumbnails — not possible
  client-side without a Meta Graph API token (see platform constraints
  above); format validation is the ceiling for Instagram links in this build.
- A "back to submission" escape hatch if a host closes submissions with zero
  entries — the presenter view handles this gracefully (shows "No clips were
  submitted this round" and disables "Start voting") but there's no path
  back to re-open submissions for that round. Edge case that shouldn't come
  up in normal play; flagging rather than building an unused control.

Firebase config in `js/firebase.js` is filled in with the real
`tragedy-of-the-commons-4e239` project values (not a placeholder) — this was
tested against the live database, not the emulator.

### Commits
- `4726977` — initial build, pushed to `main` on
  `https://github.com/aJakeoo/tragedy-of-the-commons.git` before QA closeout
  (per an ASAP request mid-session) — includes the thumbnail-height fix and
  the loading-state fix, but predates the round-2/3 re-verification above.
- Follow-up commit with this QA closeout note pushed immediately after.

## Session 2 — Live bug report: "Start game" did nothing

User reported the deployed app (GitHub Pages, `ajakeoo.github.io/tragedy-of-the-commons/`,
tested on iOS Safari) hung on the lobby screen — clicking "Start game" had
no visible effect and never advanced.

**Investigation:** Reproduced directly against the live Firestore project.
Ruled out the deploy itself (GitHub Pages was serving current code, no console
errors) and ruled out Firestore being generally broken (isolated writes to
throwaway documents consistently succeeded in 120–450ms). The actual bug:
Firestore applies a write to its **local cache optimistically**, before the
network round trip to the server completes — `subscribeToRoom`'s listener on
the lobby page was reacting to that same-client optimistic update and firing
a full `window.location.href = 'game.html'` navigation immediately. That
navigation tears down the page's JS context — including the still-in-flight
outbound write request — before it ever reached Firestore's servers. Net
effect: the button appeared to do something (disabled, "Starting..."), the
page navigated to game.html, game.html found `status` still `'lobby'` and
bounced back to lobby.html, and the room's actual `status` field in the
database never changed at all. No error ever surfaced because nothing
technically threw — the write's promise was simply abandoned mid-flight by
the navigation. Confirmed by calling `firebase.js`'s exported functions
directly (bypassing all UI) — they succeeded reliably in ~300ms every time,
proving the data layer itself was never the problem.

**Fixes:**
1. **`js/lobby.js`** — the host now navigates to `game.html` directly off the
   resolved `startRound()` promise (which only resolves after server
   acknowledgment), instead of waiting for its own listener to react to the
   optimistic local update. Guests still navigate via the listener, which is
   correct for them — they're reacting to someone *else's* write, not racing
   their own.
2. **`js/firebase.js`** — collapsed the data model from a fan-out of up to six
   Firestore documents/collections per room (room, players, round,
   playerSubmissions, submissions, ballots) into a single `rooms/{code}`
   document with nested map fields, cutting `subscribeToRoom` from up to six
   concurrent `onSnapshot` listeners down to one. This wasn't the root cause
   of the bug above, but it's a genuine reliability and simplicity win
   (fewer concurrent long-polling connections per client) discovered while
   investigating, and required no changes to any phase module — they all
   already consumed `room.players` / `room.rounds[n].*` in exactly this
   shape.
3. **`js/firebase.js`, `js/config.js`** — every Firestore call is now wrapped
   in a 12-second timeout (`FIRESTORE_WRITE_TIMEOUT_MS`) that rejects with a
   catchable `TIMED_OUT` error instead of letting a call hang forever with no
   feedback. Every host action button (`landing.js`, `lobby.js`,
   `submission.js`, `presenter.js`, `voting.js`, `reveal.js`) now has a
   try/catch around its write: on failure the button re-enables with its
   original label and a visible error message appears (new shared
   `js/uiError.js` for the four `game.html` phases), instead of staying
   stuck on a loading label with no way to retry. This doesn't fix a root
   cause by itself, but it means a genuinely flaky network no longer produces
   a silent, unrecoverable dead end.
4. **`js/game.js`** — added a 2-second grace period before bouncing back to
   `lobby.html` on seeing `status === 'lobby'`, in case a freshly-loaded
   page's first snapshot ever lags behind a just-confirmed write from
   elsewhere. Defensive; not the fix for the bug above, but cheap insurance
   against the same class of read-after-write race in other directions.

**Verified:** created a fresh room, started it, and confirmed via a direct
Firestore REST read (bypassing the app entirely) that `status` flipped to
`submitting` and `round` to `1` — the actual bug condition (write silently
never landing) is gone. No page bounce, no stuck button, single clean
navigation to `game.html`.

## Session 3 — Inline video playback in the presenter view

User asked whether the host could stay in the app during the compiled-list
phase instead of tapping "Open clip" and leaving to TikTok/Instagram, and
whether playback could happen automatically.

**What's possible vs. not:** TikTok's oEmbed response (already being fetched
for validation — see `linkValidation.js`) includes ready-made embed HTML: a
`<blockquote class="tiktok-embed">` plus their own `embed.js` loader, which
renders TikTok's real interactive player (like/comment counts, captions, tap
to play) inline via an iframe. Instagram has an equivalent public embed
format (`<blockquote class="instagram-media">` + `instagram.com/embed.js`).
Both were added. True *automatic* playback isn't achievable on either
platform — browsers block silent autoplay broadly, and neither embed SDK
exposes an autoplay flag even for muted playback. So the host now stays in
the app and taps play inline instead of opening a new tab, but a tap is
still required.

**Changes:**
- `js/linkValidation.js` — TikTok's oEmbed result now also captures `data.html`
  (the embed snippet) as `embedHtml`, threaded through `submission.js`'s
  submit handler and `scoring.js`'s `mergeSubmissions` so it survives into
  the round's compiled entries.
- `js/embeds.js` (new) — renders the TikTok blockquote + reloads their
  `embed.js` (their SDK has no documented "reprocess" call, so a fresh
  `<script>` tag is swapped in each time, which is the standard trick for
  single-page apps); renders an Instagram blockquote and calls their
  documented `instgrm.Embeds.process()`, which does support reprocessing.
- `js/presenter.js` — replaced the thumbnail image + "Open clip" link with
  the inline embed. Added a guard (`lastRenderedEntryId`) so the embed only
  re-renders when the actual clip changes, not on every unrelated snapshot
  update (e.g. toggling "show who submitted" used to reset/reload whatever
  the host was watching — confirmed this stays stable across that toggle in
  testing).
- `css/style.css` — sizing rules so the embeds (which manage their own
  internal layout) don't overflow the card.

**Verified:** submitted a known-live TikTok link, closed submissions, and
confirmed the presenter card renders the real interactive TikTok embed
(caption, like/comment counts, tap-to-play) instead of a static thumbnail,
and that toggling the attribution checkbox doesn't reset it.
