# Chess Clock Timer

A digital chess clock / chess timer for two players sharing a physical chess
board.

> **This is a chess clock, not a chess game.** It has no board, no pieces,
> no move validation, no rules engine, and no idea what "checkmate" means.
> It only replaces the physical clock sitting next to the board: it counts
> down each player's remaining time, switches sides, counts completed
> moves, applies increment/delay, and tells you when someone's flag falls.
> Everything about how the actual chess game is played happens on the real
> board, entirely outside this app.

## What it does

Two players play chess normally on a real board. After each move, the
player who just moved taps their own half of the screen — exactly like
pressing a physical clock button:

1. Their clock stops.
2. Their move counter increments.
3. Their increment (if configured) is added.
4. The opponent's clock starts.

There is never a moment where both clocks run simultaneously. When a
player's time hits zero, both clocks stop immediately and the app clearly
shows who ran out — it does not, and cannot, determine checkmate, stalemate,
draws, or any other chess result.

## Architecture

```
public/
  index.html              Setup screen + clock screen (single page, no router)
  css/styles.css           All styling
  js/
    timerEngine.js         Pure timer state machine — zero DOM, zero network.
                            This is the entire "brain" of the app.
    app.js                 DOM controller: reads engine snapshots, renders
                            them, and turns taps/clicks into engine calls.
    storage.js              localStorage: settings + local session history.
    feedback.js              Web Audio beeps + Vibration API.
    wakeLock.js               Screen Wake Lock API wrapper.
    firebaseHistory.js        Optional, lazy-loaded Firestore session backup.
    firebase-config.example.js  Template — copy to firebase-config.js (gitignored).
  manifest.json            PWA manifest.
  service-worker.js        Offline app-shell caching.
  icons/                   PWA/home-screen icons.
tests/
  timerEngine.test.js      Full engine test suite (Node's built-in test runner).
firestore.rules            The only backend "logic": Firestore write validation.
FIREBASE_SETUP.md          Optional: connect this app to your own Firebase
                            project for cloud session-history backup (the app
                            itself is hosted on GitHub Pages, not Firebase).
```

The split between `timerEngine.js` (pure logic) and `app.js` (DOM glue) is
deliberate: the engine has no reference to `document`, `window`, or any
browser API, so the entire timer state machine is unit-testable in plain
Node with no test-DOM, no mocking of `setInterval`, and no flaky timing —
see [Timer accuracy strategy](#timer-accuracy-strategy) below for why that
matters.

## Timer accuracy strategy

The clock is never implemented as "subtract N ms every `setInterval` tick."
That approach silently drifts: dropped frames, a backgrounded tab, or a
device that briefly freezes all cause missed ticks, and missed ticks mean
lost (or double-counted) time.

Instead, `ChessClockEngine` is **timestamp-anchored**: it stores real
`Date.now()` values (`turnStartedAt`, plus an accumulated
`turnElapsedBeforePauseMs` for time already spent in the current turn before
any pause) and computes remaining time on demand as a pure function of
"now":

```
remaining = remainingAtTurnStart - max(0, (now - turnStartedAt + alreadyElapsed) - delayMs)
```

`app.js` calls `engine.getSnapshot(Date.now())` on every animation frame
purely to *render* the current value — calling it more or less often never
changes the answer, only how fresh the display looks. This means the clock
is correct even if:

- The tab is backgrounded for two minutes and `requestAnimationFrame` never
  fires during that time — the very next frame after regaining focus
  computes the correct elapsed time in one step.
- The device's frame rate drops to a crawl.
- Many render calls happen back-to-back (rapid taps, high FPS) — reading a
  snapshot is a pure calculation, never a mutation.

`engine.checkExpiration(now)` is a passive check run on every tick: because
it's timestamp-based, it correctly detects a flag that "fell" while the tab
was backgrounded, the instant the app comes back into view — see the
`visibilitychange` handler in `app.js`.

Internally all values are tracked in whole **milliseconds**; the UI switches
to a `9.8` / `9.7` / `9.6` tenths-of-a-second display under 10 seconds
remaining, sourced from that same millisecond precision.

## Clock switching

`engine.press(player, now)` is the only way the active player changes, and
it's intentionally strict: it's a no-op unless `state === RUNNING` **and**
`player === activePlayer`. That single guard is what makes "never both
clocks running" and "ignore accidental double-taps / wrong-side presses"
true simultaneously — a second tap on the same side after a switch is
rejected because the active player has already changed; a tap on the
opponent's (inactive) side is rejected outright.

## Move counter

`player1Moves` / `player2Moves` increment by exactly one on each **accepted**
`press()` — a rejected press (wrong player, wrong state) never increments
anything. The app has no idea what move was made; it only counts completed
turns.

## Increment (Fischer) and delay

- **Increment**: added to a player's clock immediately after their accepted
  press, e.g. `5 + 3` = 5 minutes starting, +3 seconds after every move.
- **Delay** (US delay / Bronstein-style): the first `delayMs` of each turn
  elapse without decrementing that player's remaining time; only time beyond
  the delay window actually counts down. The delay window resets fresh on
  every turn and correctly accumulates across pause/resume within a turn.

## Handicap ("chấp giờ")

Setup has an optional **Handicap** toggle that gives each player their own
starting time instead of both sharing one value — e.g. a stronger player
starts with 5 minutes while their opponent gets 10. In the engine this is
just `configure({ player1StartMs, player2StartMs, ... })`; increment and
delay are always shared between both players, only starting time can differ.
Everything else (switching, increment, delay, undo, expiration) behaves
identically to a normal symmetric match — each player's clock is simply
tracked against their own starting allotment.

## Pause / Resume

`pause()` freezes both players' remaining time (by folding elapsed turn time
into `turnElapsedBeforePauseMs`); `resume()` continues from exactly that
frozen value. Screen Wake Lock is released on pause and re-acquired on
resume.

## Undo

Every accepted `press()` pushes a snapshot (remaining times, move counts,
active player, timer state) onto a local, in-memory history stack before
mutating anything. `undo()` pops and restores that snapshot. If the restored
state is `RUNNING`, the reverted player's clock resumes counting from the
moment Undo was pressed — not from the old, now-stale turn-start timestamp —
so the real-world time spent reaching for the Undo button is never silently
charged to anyone. Undo is 100% local; it never touches Firebase and works
fully offline.

## Offline support & architecture

Everything required to actually run a game — countdown, clock switching,
move counting, increment, delay, pause/resume, undo, restart — is pure
client-side JavaScript with **zero network calls**. A service worker
(`service-worker.js`) precaches the full app shell (HTML/CSS/JS/icons) on
first load so the app keeps working with no connection at all afterward,
including a cold load while offline (`manifest.json` + service worker =
installable PWA on iPad/iPhone/desktop).

## Firebase usage

The app is hosted on GitHub Pages (see
[Deployment](#deployment-github-pages)) — Firebase is not involved in
serving it. Firebase is used for exactly one optional thing: backing up a
**completed**
session's summary (names, starting time, increment/delay, final move
counts, final remaining time, who ran out, start/end timestamps) to
Firestore, in addition to the local history that's always kept in
`localStorage` regardless. See `FIREBASE_SETUP.md` for connecting your own
project.

Hard guarantees:
- The Firebase SDK is only pulled in via dynamic `import()` the first time
  it's actually needed — never on initial app load.
- The running/live timer state is **never** written anywhere, ever — only a
  summary once a session ends.
- Every Firebase call is timeout-guarded and fails silently; a slow or
  offline network can never block or delay a clock press, pause, or undo.
- With no `public/js/firebase-config.js` present (the default for a fresh
  clone), the app runs exactly the same, just without the optional cloud
  backup — see `firebase-config.example.js`.
- No login/authentication is used anywhere — local/guest history always
  works, and Firestore writes are validated by `firestore.rules` alone
  (append-only: a session can be created, never edited or deleted).

## Development

```bash
npm test         # run the timer engine test suite
npm run serve    # serve public/ locally at http://localhost:5173
npm run icons    # regenerate PWA icons (scripts/generate-icons.mjs)
```

No build step, no bundler, no framework — `public/` is deployed as-is.

## Testing

`tests/timerEngine.test.js` exercises the engine directly (no DOM, no
browser), using an injectable fake clock so tests control simulated time
precisely instead of racing real timers. Covers: normal countdown, P1→P2 and
P2→P1 switching, move counting, Fischer increment (including compounding
across turns), delay (including across a pause), pause/resume, undo
(including undoing a time-expiration and multiple sequential undos),
restart/new timer, time expiration (including exactly-at-zero), rapid
repeated tapping (spam vs. legitimate fast alternation), rendering-delay /
backgrounded-tab resilience (large time jumps with no ticks in between), and
millisecond-level precision for the tenths-of-a-second low-time display.

```bash
npm test
```

## Deployment (GitHub Pages)

The app is hosted on **GitHub Pages** — Firebase is not involved in serving
it. There's no build step, so "deploying" just means publishing `public/`
as-is.

Automatically: `.github/workflows/deploy.yml` runs the test suite, then
uploads `public/` to GitHub Pages on every push to `main`, via
`actions/upload-pages-artifact` + `actions/deploy-pages`. One-time setup:
**Settings → Pages → Source: GitHub Actions**.

The same workflow also has an optional `firestore-rules` job that deploys
`firestore.rules`/`firestore.indexes.json` — but only if you've configured
the Firebase secrets described in `FIREBASE_SETUP.md`. Without them, Pages
still deploys the app normally on every push; it just runs with local-only
session history, which is a fully supported way to use this app.

To deploy manually instead of via Actions, push `public/`'s contents to a
`gh-pages` branch (or any static host — it's plain files, nothing
GitHub-Pages-specific about the app itself) with your tool of choice, e.g.
[`gh-pages`](https://www.npmjs.com/package/gh-pages) or `git subtree push`.

See `FIREBASE_SETUP.md` for the optional Firestore session-history backup —
entirely separate from hosting, and entirely optional.
