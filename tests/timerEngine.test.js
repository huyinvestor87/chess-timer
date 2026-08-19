import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChessClockEngine, TimerState } from '../public/js/timerEngine.js';

/** A fake clock so tests control "now" precisely instead of racing real time. */
function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (ms) => { t = ms; return t; };
  return now;
}

function newEngine(now, config = {}) {
  const engine = new ChessClockEngine({ now });
  engine.configure({
    player1Name: 'Alice',
    player2Name: 'Bob',
    startMs: 5 * 60 * 1000,
    incrementMs: 0,
    delayMs: 0,
    firstPlayer: 1,
    ...config,
  });
  return engine;
}

describe('setup / configure', () => {
  test('starts in SETUP before configure()', () => {
    const engine = new ChessClockEngine({ now: makeClock() });
    assert.equal(engine.state, TimerState.SETUP);
  });

  test('configure() moves to READY with full starting time for both players', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    assert.equal(engine.state, TimerState.READY);
    assert.equal(engine.player1RemainingMs, 60_000);
    assert.equal(engine.player2RemainingMs, 60_000);
    assert.equal(engine.player1Moves, 0);
    assert.equal(engine.player2Moves, 0);
  });
});

describe('normal countdown', () => {
  test('remaining time decreases as wall-clock time passes for the active player', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    engine.start(now());
    now.advance(1_500);
    const snap = engine.getSnapshot(now());
    assert.equal(snap.activePlayer, 1);
    assert.equal(snap.player1RemainingMs, 58_500);
    assert.equal(snap.player2RemainingMs, 60_000); // inactive player untouched
  });

  test('getSnapshot is a pure read — repeated calls do not double-decrement', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    engine.start(now());
    now.advance(1_000);
    const a = engine.getSnapshot(now());
    const b = engine.getSnapshot(now());
    assert.equal(a.player1RemainingMs, b.player1RemainingMs);
  });
});

describe('clock switching', () => {
  test('player 1 press stops P1 and starts P2', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    now.advance(2_000);
    assert.equal(engine.press(1, now()), true);
    assert.equal(engine.activePlayer, 2);
    now.advance(3_000);
    const snap = engine.getSnapshot(now());
    // P1 stopped at the moment of the press and must not keep decreasing.
    assert.equal(snap.player1RemainingMs, 5 * 60 * 1000 - 2_000);
    assert.equal(snap.player2RemainingMs, 5 * 60 * 1000 - 3_000);
  });

  test('player 2 press stops P2 and starts P1', () => {
    const now = makeClock();
    const engine = newEngine(now, { firstPlayer: 2 });
    engine.start(now());
    now.advance(1_000);
    engine.press(2, now());
    assert.equal(engine.activePlayer, 1);
    now.advance(4_000);
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player2RemainingMs, 5 * 60 * 1000 - 1_000);
    assert.equal(snap.player1RemainingMs, 5 * 60 * 1000 - 4_000);
  });

  test('never both running: a press for the inactive player is ignored', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    now.advance(1_000);
    const before = engine.getSnapshot(now());
    const accepted = engine.press(2, now()); // player 2 tries to press while P1 is active
    assert.equal(accepted, false);
    assert.equal(engine.activePlayer, 1);
    const after = engine.getSnapshot(now());
    assert.equal(after.player1RemainingMs, before.player1RemainingMs);
    assert.equal(after.player2RemainingMs, before.player2RemainingMs);
  });
});

describe('move counter', () => {
  test('each accepted press increments only that player\'s move count', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    engine.press(1, now.advance(100));
    assert.equal(engine.player1Moves, 1);
    assert.equal(engine.player2Moves, 0);
    engine.press(2, now.advance(100));
    assert.equal(engine.player1Moves, 1);
    assert.equal(engine.player2Moves, 1);
  });

  test('a rejected press does not increment the move counter', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    engine.press(2, now()); // wrong player, rejected
    assert.equal(engine.player1Moves, 0);
    assert.equal(engine.player2Moves, 0);
  });
});

describe('Fischer increment', () => {
  test('increment is added to the pressing player\'s clock after their move', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, incrementMs: 3_000 });
    engine.start(now());
    now.advance(5_000);
    engine.press(1, now());
    // 60s - 5s elapsed + 3s increment = 58s
    assert.equal(engine.player1RemainingMs, 58_000);
  });

  test('increment compounds turn over turn for each player independently', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, incrementMs: 2_000 });
    engine.start(now());
    engine.press(1, now.advance(1_000)); // P1: 60-1+2 = 61
    engine.press(2, now.advance(1_000)); // P2: 60-1+2 = 61
    engine.press(1, now.advance(1_000)); // P1: 61-1+2 = 62
    assert.equal(engine.player1RemainingMs, 62_000);
    assert.equal(engine.player2RemainingMs, 61_000);
  });
});

describe('delay', () => {
  test('time within the delay window does not decrement remaining time', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, delayMs: 5_000 });
    engine.start(now());
    now.advance(3_000); // still inside the 5s delay window
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 60_000);
    assert.equal(snap.inDelay, true);
  });

  test('only time beyond the delay window decrements remaining time', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, delayMs: 5_000 });
    engine.start(now());
    now.advance(8_000); // 5s delay + 3s real decrement
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 57_000);
    assert.equal(snap.inDelay, false);
  });

  test('delay is re-applied fresh on every turn', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, delayMs: 2_000 });
    engine.start(now());
    engine.press(1, now.advance(2_000)); // exactly the delay window, no decrement
    assert.equal(engine.player1RemainingMs, 60_000);
    now.advance(1_000); // P2 now inside their own fresh delay window
    assert.equal(engine.getSnapshot(now()).player2RemainingMs, 60_000);
  });
});

describe('pause / resume', () => {
  test('pause freezes both remaining times', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    now.advance(2_000);
    engine.pause(now());
    assert.equal(engine.state, TimerState.PAUSED);
    const snapAtPause = engine.getSnapshot(now());
    now.advance(10_000); // time passes in the real world while paused
    const snapLater = engine.getSnapshot(now());
    assert.equal(snapLater.player1RemainingMs, snapAtPause.player1RemainingMs);
  });

  test('resume continues counting down from the frozen value', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    engine.start(now());
    now.advance(2_000);
    engine.pause(now());
    now.advance(50_000); // irrelevant, paused
    engine.resume(now());
    now.advance(3_000);
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 60_000 - 2_000 - 3_000);
  });

  test('pause/resume across a delay window accumulates correctly', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, delayMs: 5_000 });
    engine.start(now());
    now.advance(3_000); // 3s into a 5s delay
    engine.pause(now());
    now.advance(999_000); // long real-world pause
    engine.resume(now());
    now.advance(4_000); // 3s (before pause) + 4s (after) = 7s total elapsed -> 2s past delay
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 58_000);
  });

  test('pressing while paused is ignored (only one state may run at a time)', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    engine.pause(now());
    const accepted = engine.press(1, now());
    assert.equal(accepted, false);
    assert.equal(engine.state, TimerState.PAUSED);
  });
});

describe('undo', () => {
  test('undo restores remaining times, move counts, and active player', () => {
    // Mirrors the spec's example: P1 Moves 18 / P2 Moves 17, then P2
    // accidentally double-presses and Undo should bring P2 back to 17.
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, incrementMs: 3_000 });
    engine.start(now());
    engine.player1Moves = 18;
    engine.player2Moves = 17;
    engine.activePlayer = 2; // it's P2's turn to press

    const p1RemainingBefore = engine.player1RemainingMs;
    const p2RemainingBefore = engine.player2RemainingMs;

    now.advance(2_000);
    engine.press(2, now());
    assert.equal(engine.player2Moves, 18);
    assert.equal(engine.activePlayer, 1);

    const undone = engine.undo();
    assert.equal(undone, true);
    assert.equal(engine.player1Moves, 18);
    assert.equal(engine.player2Moves, 17);
    assert.equal(engine.activePlayer, 2);
    assert.equal(engine.player1RemainingMs, p1RemainingBefore);
    assert.equal(engine.player2RemainingMs, p2RemainingBefore);
  });

  test('undo after time expiration restores play', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 1_000 });
    engine.start(now());
    now.advance(2_000);
    engine.press(1, now()); // expires P1
    assert.equal(engine.state, TimerState.FINISHED);
    assert.equal(engine.expiredPlayer, 1);

    const undone = engine.undo();
    assert.equal(undone, true);
    assert.equal(engine.state, TimerState.RUNNING);
    assert.equal(engine.expiredPlayer, null);
  });

  test('undo with empty history is a no-op', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    assert.equal(engine.undo(), false);
  });

  test('multiple undos walk back through several presses', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    engine.press(1, now.advance(100));
    engine.press(2, now.advance(100));
    engine.press(1, now.advance(100));
    assert.equal(engine.player1Moves, 2);
    engine.undo();
    assert.equal(engine.player1Moves, 1);
    assert.equal(engine.activePlayer, 1);
    engine.undo();
    assert.equal(engine.player1Moves, 1);
    assert.equal(engine.player2Moves, 0);
    engine.undo();
    assert.equal(engine.player1Moves, 0);
    assert.equal(engine.activePlayer, 1);
  });
});

describe('restart', () => {
  test('restart resets clocks and moves but keeps configuration', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, incrementMs: 5_000 });
    engine.start(now());
    engine.press(1, now.advance(1_000));
    engine.restart();
    assert.equal(engine.state, TimerState.READY);
    assert.equal(engine.player1RemainingMs, 60_000);
    assert.equal(engine.player2RemainingMs, 60_000);
    assert.equal(engine.player1Moves, 0);
    assert.equal(engine.player2Moves, 0);
    assert.equal(engine.config.incrementMs, 5_000);
  });

  test('newTimer resets fully back to SETUP', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    engine.newTimer();
    assert.equal(engine.state, TimerState.SETUP);
    assert.equal(engine.config, null);
  });
});

describe('time expiration', () => {
  test('pressing with insufficient remaining time expires that player at zero', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 5_000 });
    engine.start(now());
    now.advance(6_000);
    engine.press(1, now());
    assert.equal(engine.state, TimerState.FINISHED);
    assert.equal(engine.expiredPlayer, 1);
    assert.equal(engine.player1RemainingMs, 0);
  });

  test('checkExpiration() detects zero time passively without a press', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 5_000 });
    engine.start(now());
    now.advance(6_000);
    const expired = engine.checkExpiration(now());
    assert.equal(expired, true);
    assert.equal(engine.state, TimerState.FINISHED);
    assert.equal(engine.expiredPlayer, 1);
  });

  test('once finished, further presses are rejected and the other player\'s time is frozen', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 5_000 });
    engine.start(now());
    now.advance(6_000);
    engine.checkExpiration(now());
    const p2Before = engine.getSnapshot(now()).player2RemainingMs;
    now.advance(3_000);
    assert.equal(engine.press(2, now()), false);
    const p2After = engine.getSnapshot(now()).player2RemainingMs;
    assert.equal(p2After, p2Before);
  });

  test('clock press exactly at/near zero remaining does not go negative', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 1_000 });
    engine.start(now());
    now.advance(1_000); // exactly zero remaining
    engine.press(1, now());
    assert.equal(engine.state, TimerState.FINISHED);
    assert.equal(engine.player1RemainingMs, 0);
  });
});

describe('rapid repeated tapping', () => {
  test('spamming the active player\'s side only registers the first press', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    now.advance(500);
    const results = [engine.press(1, now()), engine.press(1, now()), engine.press(1, now())];
    assert.deepEqual(results, [true, false, false]);
    assert.equal(engine.player1Moves, 1);
  });

  test('alternating legitimate fast taps each register exactly once', () => {
    const now = makeClock();
    const engine = newEngine(now);
    engine.start(now());
    for (let i = 0; i < 20; i++) {
      const player = engine.activePlayer;
      assert.equal(engine.press(player, now.advance(10)), true);
    }
    assert.equal(engine.player1Moves + engine.player2Moves, 20);
  });
});

describe('rendering delay / background-foreground resilience', () => {
  test('a long gap with no getSnapshot calls in between still yields the correct value', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    engine.start(now());
    // Simulate a frozen/backgrounded tab: no snapshot calls for a long stretch.
    now.advance(45_000);
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 15_000);
  });

  test('expiration is still detected correctly after a large background jump', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 10_000 });
    engine.start(now());
    now.advance(120_000); // tab backgrounded for 2 minutes
    const expired = engine.checkExpiration(now());
    assert.equal(expired, true);
    assert.equal(engine.player1RemainingMs, 0);
  });

  test('many rapid getSnapshot calls (simulating high FPS) agree with each other', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000 });
    engine.start(now());
    now.advance(1_234);
    const snaps = Array.from({ length: 50 }, () => engine.getSnapshot(now()).player1RemainingMs);
    assert.ok(snaps.every((v) => v === snaps[0]));
  });
});

describe('low-time precision', () => {
  test('remaining time is tracked in whole milliseconds for tenths-of-a-second display', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 10_000 });
    engine.start(now());
    now.advance(150);
    const snap = engine.getSnapshot(now());
    assert.equal(snap.player1RemainingMs, 9_850);
  });
});

describe('handicap ("chấp giờ" — asymmetric starting time per player)', () => {
  test('player1StartMs/player2StartMs override the shared startMs independently', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, player1StartMs: 10 * 60_000, player2StartMs: 5 * 60_000 });
    assert.equal(engine.player1RemainingMs, 10 * 60_000);
    assert.equal(engine.player2RemainingMs, 5 * 60_000);
  });

  test('omitting the per-player override falls back to the shared startMs (symmetric, default behavior)', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, player1StartMs: 10 * 60_000 });
    assert.equal(engine.player1RemainingMs, 10 * 60_000);
    assert.equal(engine.player2RemainingMs, 60_000);
  });

  test('increment and delay stay shared even in a handicap match', () => {
    const now = makeClock();
    const engine = newEngine(now, {
      startMs: 60_000, player1StartMs: 10 * 60_000, player2StartMs: 5 * 60_000, incrementMs: 3_000,
    });
    engine.start(now());
    engine.press(1, now.advance(1_000)); // 10min - 1s + 3s
    assert.equal(engine.player1RemainingMs, 10 * 60_000 - 1_000 + 3_000);
    engine.press(2, now.advance(1_000)); // 5min - 1s + 3s, same increment
    assert.equal(engine.player2RemainingMs, 5 * 60_000 - 1_000 + 3_000);
  });

  test('each player independently expires against their own starting time', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, player1StartMs: 2_000, player2StartMs: 60_000 });
    engine.start(now());
    now.advance(3_000); // exceeds P1's 2s handicap allotment, well within P2's normal minute
    const expired = engine.checkExpiration(now());
    assert.equal(expired, true);
    assert.equal(engine.expiredPlayer, 1);
    assert.equal(engine.player2RemainingMs, 60_000); // untouched — P2 never got to move
  });

  test('restart() preserves each player\'s individual handicap starting time', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, player1StartMs: 10 * 60_000, player2StartMs: 5 * 60_000 });
    engine.start(now());
    engine.press(1, now.advance(1_000));
    engine.restart();
    assert.equal(engine.state, TimerState.READY);
    assert.equal(engine.player1RemainingMs, 10 * 60_000);
    assert.equal(engine.player2RemainingMs, 5 * 60_000);
  });

  test('toHistoryRecord() reports each player\'s starting time separately', () => {
    const now = makeClock();
    const engine = newEngine(now, { startMs: 60_000, player1StartMs: 10 * 60_000, player2StartMs: 5 * 60_000 });
    engine.start(now());
    const record = engine.toHistoryRecord();
    assert.equal(record.player1StartingTimeMs, 10 * 60_000);
    assert.equal(record.player2StartingTimeMs, 5 * 60_000);
  });
});
