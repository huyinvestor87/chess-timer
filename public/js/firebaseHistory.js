/**
 * Optional Firebase persistence for COMPLETED timer sessions only.
 *
 * Hard rules this module exists to honor:
 *  - Firebase is NEVER required for active timing. Every function here is
 *    best-effort, timeout-guarded, and fire-and-forget from the caller's
 *    perspective — a slow or failed network call must never block or delay
 *    a clock press.
 *  - The (fairly large) Firebase SDK is only pulled in via dynamic import
 *    the first time it's actually needed (saving/loading history), never on
 *    initial app load — the core clock screen must stay fast and work
 *    offline with zero network activity.
 *  - We NEVER write the running timer state itself, only a summary once a
 *    session ends (see timerEngine.js#toHistoryRecord).
 *
 * Firebase config is loaded from `./firebase-config.js`, a gitignored file
 * the user creates locally (see firebase-config.example.js and
 * FIREBASE_SETUP.md). If that file doesn't exist, all functions below
 * resolve to "not configured" and the app runs entirely on local history.
 */

const SDK_VERSION = '10.14.1';
const COLLECTION_PREFIX = 'chessClockTimer_';
const SESSIONS_COLLECTION = `${COLLECTION_PREFIX}sessions`;

let dbPromise = null;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function loadConfig() {
  try {
    const mod = await import('./firebase-config.js');
    const config = mod.firebaseConfig;
    if (config && config.apiKey && config.projectId && config.apiKey !== 'REPLACE_ME') {
      return config;
    }
  } catch {
    // firebase-config.js not present — expected for anyone who hasn't set
    // up Firebase yet. This is not an error.
  }
  return null;
}

/** Lazily initializes Firestore. Resolves to null if unconfigured/unreachable. */
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const config = await loadConfig();
      if (!config) return null;
      try {
        const [{ initializeApp }, firestore] = await Promise.all([
          import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
          import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
        ]);
        const app = initializeApp(config);
        const db = firestore.getFirestore(app);
        return { db, firestore };
      } catch (err) {
        console.warn('[chess-clock-timer] Firebase unavailable, continuing local-only.', err);
        return null;
      }
    })();
  }
  return dbPromise;
}

export async function isFirebaseConfigured() {
  return (await getDb()) !== null;
}

/**
 * Saves one completed session summary. Best-effort: resolves `true`/`false`,
 * never rejects, and gives up after 5s so a flaky connection can't hang the
 * "start a new game" flow.
 * @param {object} record shape from ChessClockEngine#toHistoryRecord()
 */
export async function saveSessionToFirebase(record) {
  const outcome = await withTimeout(
    (async () => {
      const ctx = await getDb();
      if (!ctx) return false;
      const { db, firestore } = ctx;
      await firestore.addDoc(firestore.collection(db, SESSIONS_COLLECTION), {
        ...record,
        createdAt: firestore.serverTimestamp(),
      });
      return true;
    })().catch((err) => {
      console.warn('[chess-clock-timer] Failed to save session to Firebase.', err);
      return false;
    }),
    5000,
    false,
  );
  return outcome;
}

/** Fetches the most recent N session summaries, newest first. Returns [] on any failure. */
export async function fetchRecentSessions(limitCount = 20) {
  const outcome = await withTimeout(
    (async () => {
      const ctx = await getDb();
      if (!ctx) return [];
      const { db, firestore } = ctx;
      const q = firestore.query(
        firestore.collection(db, SESSIONS_COLLECTION),
        firestore.orderBy('createdAt', 'desc'),
        firestore.limit(limitCount),
      );
      const snap = await firestore.getDocs(q);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    })().catch((err) => {
      console.warn('[chess-clock-timer] Failed to fetch Firebase history.', err);
      return [];
    }),
    5000,
    [],
  );
  return outcome;
}
