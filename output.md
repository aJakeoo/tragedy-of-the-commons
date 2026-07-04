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

**Still to do before this phase is "clean":** re-verify the round-2→3
transition for the three buttons fixed in item 3 (fix was applied but not
yet re-tested in-browser), then a final full pass with no fixes needed.

Firebase config in `js/firebase.js` is filled in with the real
`tragedy-of-the-commons-4e239` project values (not a placeholder) — this was
tested against the live database, not the emulator.
