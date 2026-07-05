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

## Session 4 — All clips at once, single-audio enforcement, per-voter reveal breakdown

Design (Roman marble / light-theme art direction) was handled separately via
a Claude Design import provided directly in-session — this session was
functional-only, no styling beyond what the behavior below required.

### What changed

1. **Presenter view now shows every round submission at once**, in a
   responsive grid (`js/presenter.js`, `#presenter-grid` in `game.html`),
   instead of one clip at a time behind prev/next navigation. This turned
   out to be genuinely avoidable, not a fallback — TikTok/Instagram's embed
   scripts handle a page with several blockquotes fine (see latency note
   below), so there was no technical reason to keep pagination. Removed
   `presentIndex` entirely from the room schema (`js/firebase.js`) since
   nothing tracks "current clip" anymore — every player, host or guest, sees
   the same static grid and can tap into any card independently.

2. **Single tap plays with sound** — this is each platform's own default
   embed behavior (TikTok and Instagram's tap-to-play widgets don't have a
   separate mute step), not something built here. Confirmed no code path
   adds an extra tap/confirmation on top of it.

3. **Only one clip plays at a time — this took two attempts.** Both embeds
   render as cross-origin iframes with no postMessage control API from
   either platform (unlike YouTube's IFrame API), so there's no real
   `pause()` available.
   - **First attempt:** on focus moving into a new clip's iframe (detected
     via the standard `window.blur` + `document.activeElement` trick, since
     click events *inside* a cross-origin iframe are otherwise invisible to
     the parent page), reset every other known iframe's `src` to itself to
     force a reload. **This broke TikTok's embed permanently** — tested by
     waiting 24+ seconds after triggering it, and the reloaded iframe never
     recovered from a blank loading state. Confirmed reproducible, not a
     one-off.
   - **Fix:** instead of reloading the iframe in place, tearing the card's
     embed container back down to the original `<blockquote>` and letting
     the platform's embed script rebuild it from scratch — exactly the same
     path used on first render, which is known to work. Verified this
     recovers reliably (tapped clip A, tapped clip B, watched clip A's card
     reset to its unplayed thumbnail state, waited ~15s, confirmed it became
     tappable again — repeatable across multiple rounds).
   - **Real, honest cost:** rebuilding takes the same ~10-18 seconds TikTok's
     embed widget takes on any first render (confirmed by timing several
     loads — this is inherent platform latency, not something introduced
     here). Stopping a clip this way means it's genuinely unplayable again
     for that window, not instantly ready. There's no way around this
     without a platform-provided control API, which doesn't exist for either
     TikTok or Instagram's public embeds.
   - **Also observed, not a bug:** on a page with 4 simultaneous TikTok
     blockquotes, some render within ~2-3 seconds and others take up to
     ~15 seconds — order didn't consistently match DOM order across runs.
     Read this as TikTok's own embed pipeline being slow/uneven under load
     rather than anything wrong in this app; a round with a very large
     number of distinct clips could feel sluggish to fully render, but
     typical round sizes (a handful of players × up to 3 links, minus
     duplicates) stayed well within tolerable wait times in testing.

4. **Reveal per-voter breakdown** (`js/scoring.js`, `js/reveal.js`):
   `tallyResults` now returns `voterBreakdown` per entry (each voter's raw
   point contribution, sorted highest first). The reveal animation shows
   each row's total build up from these ("Tommy +4" fades in, points ticks
   up, then "Randy +2", then the final weighted total with a `×N weight`
   note if the entry was a merge) instead of the row's total just appearing
   as an abstract number. Voter identity is always shown here — deliberately
   not gated by the presenter phase's submitter-attribution toggle, which is
   a separate concern (who *submitted* a clip, hideable) from who *voted*
   for it (always public at reveal, per the brief).

### QA

Ran two players (host + guest) through a full round locally with 4 distinct
TikTok clips (2 submitted by each player, using real video IDs pulled live
from TikTok to get variety beyond the one link reused in earlier sessions).

**Confirmed working:**
- All 4 clips rendered in the grid with no pagination control
- Tap-to-play-with-sound on TikTok's embed (single tap, no separate unmute
  step)
- Stopping one clip to play another correctly resets the first (verified via
  `document.activeElement` before/after, and via the visible card reset)
  and it recovers into a re-playable state after the platform's normal load
  time — no permanent breakage after the fix in item 3 above
- Reveal: exact math verified by hand (Jake gave 2 and 4 points to Riley's
  two clips, Riley gave 3 and 3 to Jake's two clips; final ranking and
  per-voter lines matched exactly, winner correctly highlighted)
- Round loop: round 1 → round 2 transitioned cleanly with no bounce
  (building on the Session 2 fix), grid reset correctly for the new round

**Not a new bug, re-confirms an existing documented limitation:** while
speed-running round 2 in testing, triggered "submit links" and "close
submissions" back to back with no gap, and the close fired before the
submission's write had round-tripped through the room listener — round 2
compiled with zero entries. This is the same "no escape hatch for a
zero-entry round" limitation flagged in Session 1's output, not something
new. A real host clicking two separate buttons will always have more than
0ms between clicks, so this is very unlikely to bite in normal play, but
worth being aware of if a host ever double-taps through the submission flow
unusually fast.

**Intentionally out of scope this session:** did not add any mitigation for
the TikTok embed rendering latency (2-15s per clip) beyond documenting it —
there's no loading indicator on individual grid cards distinguishing "still
processing" from "processed, never played." Could add a lightweight skeleton
state if this becomes an issue with larger rounds in practice.

## Session 5 — Visual design pass (Roman/classical theme)

Applied the visual design from a Claude Design mockup, "Tragedy of the
Commons.dc.html". This was a styling-only pass — no changes to game logic,
Firestore schema, or DOM element IDs, so every `js/*.js` module needed only
small additive tweaks (a couple of new elements to populate, no restructuring).

**How the design was sourced:** the user first pointed at a `claude.ai/design`
share link; that content never actually reached this session (no attachment,
no tool output containing it — genuinely never arrived, not something skipped).
Fetched the real source afterward via the `DesignSync` tool: `get_project`
identified the project as type `PROJECT_TYPE_PROJECT` (not the design-system
type the tool is nominally scoped to), but `list_files` / `get_file` worked
against it anyway. Also cross-checked against a second file the user provided
locally, `Tragedy of the Commons (standalone).html` — a bundled/compiled
export (~165K tokens of inlined runtime, not readable as source) — by serving
it locally through `serve.js` and viewing it in a browser tab as a visual
reference, which confirmed the design tokens pulled from the `.dc.html`
source were accurate before applying them.

**Design language applied:**
- Typography: Cinzel (serif, headers/display numbers) + Public Sans (body),
  loaded via Google Fonts on all three HTML pages
- Palette: warm cream/ivory background (OKLCH), terracotta accent for
  primary actions and room codes, dark green for the host badge and merge
  "weight" badges, gold gradient + pulsing glow for the reveal winner row
- Room code and player list restyled with avatar-circle initials and a
  pill-shaped host badge, matching the mockup's lobby screen
- `game.html`'s header restructured into a small wordmark + round indicator
  bar (round number now shown as a Roman numeral, e.g. "ROUND I") — the one
  actual DOM structure change this session, isolated to a `<header>` wrapper
  around the two already-existing `#game-title`/`#round-label` elements
- Reveal ranks now show as ordinals ("1st", "2nd") instead of "#1"/"#2"
  (new `js/format.js` with `toRoman`/`ordinal` helpers, shared by
  `game.js` and `reveal.js`)
- Merged/duplicate entries now show a "×N weight" pill badge (new
  `.weight-badge` CSS class) in the presenter grid, the voting ballot, and
  the reveal breakdown — previously this was inconsistent (presenter grid
  had none, reveal had a plain muted text line)
- Added a "Champion of the round" banner below the reveal list, fading in
  once the full reveal animation settles, matching the mockup

**QA:** ran a full round locally (create room → lobby → submit → presenter
grid → voting → reveal) taking a screenshot at each phase to check for
layout breakage, unreadable contrast, or overflow. Found and fixed one real
issue: the "Champion of the round" banner rendered correctly but was easy to
miss in a full-page screenshot (gold text on cream background, positioned in
a quiet gap) — confirmed via `getBoundingClientRect()` and a zoomed
screenshot that it *is* rendering with the right content and full opacity,
so left as-is rather than over-designing a fix for what turned out to be a
screenshot-legibility issue, not a real bug. Also replaced the three pages'
stale "Placeholder UI — visual design pass comes later" footer text, since
the design pass had, at that point, actually happened.

## Session 6 — Presenter sizing, mute limitation, voting UI, attribution default

User feedback after using the design-passed build: attribution should
default to visible (already changed this session, confirmed to stay), the
presenter screen's clips should be much bigger — "like scrolling a TikTok
playlist" — and repeatedly tapping a per-clip unmute control across many
clips is a lot of friction; also requested the point-budget voting UI use
+/- buttons instead of typing a number, matching the original mockup.

**Presenter sizing:** `.presenter-grid` now breaks out of the page's
centered 720px column with the standard full-bleed trick
(`width:100vw; margin-left:calc(50% - 50vw)`), one clip per row, embed
height up to 90vh. This introduced a real, easy-to-miss bug: on any page
tall enough to need a vertical scrollbar, Chrome measures `100vw` as
*including* the scrollbar's own width, producing a spurious few-pixel
horizontal scrollbar. Fixed with `overflow-x: hidden` on `html` (the
standard fix for this specific quirk). Confirmed fixed via screenshot
before/after. Full edge-to-edge width is mainly achieved on phone-width
viewports; TikTok/Instagram's embeds enforce their own internal max-width
(~600-640px) that can't be overridden from outside the iframe, so on wide
desktop screens the clip still centers at that platform-imposed size —
flagged to the user rather than silently under-delivering.

**Auto-unmute — investigated and confirmed not possible:** checked the raw
TikTok oEmbed response directly (`curl`) for any mute/sound-related iframe
parameter or data attribute — there is none; the actual `<iframe>` is built
entirely by TikTok's own `embed.js` with no configurability exposed to the
embedding page. Combined with the iframe being cross-origin (no
`postMessage` control API, confirmed back in the single-audio-enforcement
work), there is no client-side way to click or otherwise control TikTok's
internal mute button. This is a hard platform/browser security boundary, not
a gap in this implementation — didn't build a fake "auto-unmute" that
would silently not work. Added a plain-language hint next to the presenter
grid instead ("tap the speaker icon on the clip itself to turn on sound")
so the host at least knows what to expect.

**Voting UI:** replaced the `<input type="number">` point entry with
circular +/- buttons and a live point display (`js/voting.js`,
`.point-btn`/`.points-control` in CSS), matching the mockup. Buttons
disable at the natural limits (can't go below 0, can't exceed remaining
budget) instead of relying on `min`/`max` input attributes a user could
still type past.

**Verified:** submitted a clip, ran it through to the presenter screen, and
confirmed via screenshot that the horizontal-scrollbar bug was real before
the `overflow-x` fix and gone after. Did not get to a full live pass on the
voting +/- buttons or a multi-clip presenter round in this session — hit a
session-level tool rate limit partway through and prioritized shipping the
already-implemented, low-risk changes over further live verification.
Worth a quick manual check next session if anything looks off.

## Session 7 — TikTok Embed Player, and why auto-unmute still doesn't fully work

User asked for a specific, researched follow-up on Session 6's "no
postMessage API" finding: TikTok separately documents a real **Embed
Player** (`https://www.tiktok.com/player/v1/{id}`), distinct from the
oEmbed blockquote used everywhere else, with query-param configuration and
a postMessage control channel. Verified the exact wire format directly
against `developers.tiktok.com/doc/embed-player` before writing any code
(worth doing — the user's brief guessed a plausible-but-wrong shape):
messages need `{'x-tiktok-player': true, type, value}`, not just
`{type, value}`, and `onPlayerError`'s payload is `{errorCode, errorType}`,
not the flat `{code}` the brief assumed. `onStateChange` sends a bare
numeric code (1 = playing, 2 = paused, 3 = buffering).

**What changed:** `js/embeds.js` now builds TikTok clips as
`<iframe src=".../player/v1/{canonicalId}?autoplay=1&muted=1&rel=0">`
instead of the oEmbed blockquote (`buildTikTokPlayer`, wired in from
`presenter.js` using the `canonicalId` already captured at submission time
in `linkValidation.js`). The blockquote path (`buildTikTokBlockquote`,
`loadTikTokEmbedScript`) is kept only as a fallback. A `message` listener
tracks `onPlayerReady`/`onStateChange`/`onPlayerError` per iframe
(`cardInfo` map, keyed by embed container). Switching which clip is
"active" (via the existing focus/blur trick from Session 4 — tapping into
a card's iframe steals window focus) now sends `pause`+`mute` to the
previously-active TikTok clip over postMessage instead of tearing it down
and rebuilding it, and sends `unMute` to the newly-active one. Instagram
clips are untouched — still oEmbed blockquote, still tap-to-play, still
torn down and rebuilt to stop (no control API exists for it, confirmed
again this session, not attempted). A TikTok clip whose player reports
`onPlayerError` with `errorCode 3002` (AUTOPLAY_ERROR) falls back
permanently to its own blockquote embed rather than getting stuck.

**Confirmed working, live, against the real player (not just code
review):**
- The postMessage channel itself — sent a manual `unMute` and got real
  `onMute`/`onVolumeChange` events back, exact shape matching the docs.
- `onPlayerReady` fires for every TikTok clip.
- Non-active TikTok clips correctly end up paused + muted shortly after
  render (confirmed two ways: the message trace, and visually — TikTok's
  own native control bar showed a play triangle + muted-speaker icon on
  the backgrounded clip).
- Switching active clip via a real click into a different card's iframe
  correctly sends `pause`+`mute` to the old one and attempts `unMute` on
  the new one — no more ~10-18s rebuild penalty for TikTok-to-TikTok
  switches, which was Session 4's documented cost of the old approach.
- TikTok clips now autoplay (muted) immediately on render — no tap needed
  just to start playback, unlike the old blockquote embed.

**Confirmed NOT reliably working — the actual auto-unmute:** traced the
raw postMessage events directly. The `unMute` command reaches the player
and briefly succeeds (`onMute:false` fires), then gets silently reverted
about 2ms later (`onMute:true`), with no error event to react to — so the
3002/AUTOPLAY_ERROR fallback never fires for this case, it just ends up
muted. This reproduced consistently across multiple fresh rounds, and
still happened after a genuine, focus-confirmed real click directly into
that specific clip's iframe — so it isn't simply "the default clip needs
its own tap." Best explanation: user activation (the "a real interaction
authorized this") does not propagate through `postMessage`. A `message`
event handler is never treated as a gesture by the browser, so even though
TikTok's own script is the one calling `unMute`, the browser's
audio-unmute policy can still block/revert it because the call didn't
originate from a synchronous, in-frame click. This is a browser platform
constraint one layer up from Session 6's "no control API at all" finding,
not a bug in this implementation, and not something client code can route
around — confirmed via `navigator.userActivation` on the host page
(`hasBeenActive: true` after the click, but that doesn't help — the async
postMessage hop is what breaks it, not lack of a real click). Left the
`unMute` attempt in (harmless, may work on browsers with different
policies) but rewrote `game.html`'s hint text to stop promising automatic
sound — it now says clips start muted and to tap the speaker icon, which
is the fallback that reliably works (a first-party click, not a relayed
one).

Also chased what looked like a sizing regression — the TikTok Embed Player
iframe rendered at 546.8px tall, which looked short next to the `75vh`
Session 6 sizing rule. Turned out to be correct: 546.8px *is* 75% of this
browser's real 729px CSS viewport height. The confusion was comparing
against the screenshot tool's 896px capture height, which runs at a
different scale (~1.23x) than actual CSS pixels — cost some wasted clicks
earlier in the session before catching this (several manual test clicks
landed on the wrong element until the scale mismatch was found via
`window.innerWidth` vs. screenshot width). No actual bug, no fix needed.

**Also verified this session (closing out Session 6's deferred item):**
the voting screen's +/- buttons, live, in a real 2-player round —
increment, decrement, the budget cap disabling `+` at the limit, `-`
disabling at 0, and ballot submission all work correctly.

**QA method note:** used two real, live public TikTok videos
(`@scout2015/video/6718335390845095173`, `@sulheejessica/video/7319529423311621406`)
verified via direct oEmbed calls, plus a syntactically-valid but
non-existent Instagram Reel URL — sufficient for Instagram since that
platform's link validation is format-only by design (no liveness check
possible, see Session 1).
