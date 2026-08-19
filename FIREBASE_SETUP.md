# Firebase Setup

Chess Clock Timer works **completely offline and fully featured with zero
Firebase setup** — countdown, clock switching, move counting, increment,
delay, pause/resume, undo, and restart are all 100% local (see
`README.md#offline-support--architecture`). Firebase is used for exactly one
optional feature: backing up completed session summaries (final scores/move
counts) to the cloud in addition to the local history that's always kept in
the browser.

This guide assumes **you have already manually created a Firebase project**
in the [Firebase Console](https://console.firebase.google.com/). This app
does not, and should not, create a Firebase project for you — see
`references/firebase-console-setup.md`-style reasoning: project/database
creation involves a couple of permanent choices (Firestore region, mode)
that deserve a deliberate one-time human click-through rather than a script
picking defaults.

There's no build step for this app (no bundler/framework) — "connecting" it
to your project is just dropping in a config file and a security rules file.

## 1. Enable Firestore on your existing project

In your Firebase project's Console:

1. **Build → Firestore Database → Create database** (skip this if you've
   already enabled Firestore) → choose **production mode** → pick a region.
   This step must be done by hand — it's permanent and Firebase intentionally
   doesn't let a CI service account create the database on its own.
2. **Build → Firestore Database → Rules** → paste in the contents of this
   repo's `firestore.rules` → **Publish**. (GitHub Actions will also deploy
   this file automatically on every push once you've set up the secrets in
   step 4 — this manual publish just unblocks local development first.)

The rules restrict writes to one collection, `chessClockTimer_sessions`,
and only allow **creating** a new, well-formed session summary — never
editing or deleting one. No Authentication/login is used anywhere in this
app; that's intentional (see README).

## 2. Register a web app and get your config

Project settings (gear icon, top left) → **General** → "Your apps" → Add
app → **Web** (`</>`) → give it a nickname → it shows you a `firebaseConfig`
object. Copy the **whole object**.

Now connect the app to it locally:

```bash
cp public/js/firebase-config.example.js public/js/firebase-config.js
```

Paste your copied `firebaseConfig` object into the new
`public/js/firebase-config.js`, replacing the placeholder values:

```js
export const firebaseConfig = {
  apiKey: 'AIza...',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '...',
  appId: '1:...:web:...',
};
```

`public/js/firebase-config.js` is gitignored on purpose (see `.gitignore`) —
these values aren't secret (they ship in any client bundle regardless of how
carefully you guard them), but keeping the file out of git means anyone who
clones this repo starts with Firebase history disabled by default and the
app running purely local/offline, which is the safe default for this app.

If this file is missing or still has placeholder values, `firebaseHistory.js`
silently treats Firebase as "not configured" — session summaries are simply
kept in local (browser) history only, and the (fairly large) Firebase SDK is
never even downloaded. Nothing else in the app changes or breaks.

## 3. Firebase Hosting

`firebase.json` at the repo root already points Hosting at the `public/`
directory (this app's entire client — no build output to point at). Nothing
to configure here beyond having the Firebase CLI available, which `npx`
handles on demand.

## 4. Configure the GitHub Actions deploy secrets (for automatic deploys)

`.github/workflows/deploy.yml` deploys Hosting + Firestore rules on every
push to `main`. It needs two repository secrets (**Settings → Secrets and
variables → Actions → New repository secret**):

| Secret | Value |
|---|---|
| `FIREBASE_WEB_CONFIG` | The same `firebaseConfig` object you pasted in step 2, as one JSON value. |
| `FIREBASE_SERVICE_ACCOUNT` | Project settings → **Service accounts** → "Generate new private key" → paste the whole downloaded JSON file. This one is a real credential — never commit it. |

No separate project-id secret is needed — the workflow extracts `projectId`
from `FIREBASE_WEB_CONFIG` itself at deploy time.

## 5. Run locally

```bash
npm run serve        # serves public/ at http://localhost:5173
npm test              # runs the timer-engine test suite (no server needed)
```

No build step — edit files under `public/` and reload.

## 6. Deploy

Automatically: push to `main` (once the two secrets above are set).

Manually, from your own machine (requires the Firebase CLI, via `npx`, and
that you're logged in with `npx firebase-tools login`):

```bash
npm run deploy         # deploys Hosting only
npm run deploy:rules   # deploys firestore.rules + firestore.indexes.json only
```

## Troubleshooting

- **"No projectId/project_id field found in FIREBASE_WEB_CONFIG secret"**
  (in a GitHub Actions log) — the secret is empty or not valid JSON.
  Re-copy the whole `firebaseConfig` object from Console step 2 exactly as
  shown.
- **`action-hosting-deploy` or `firebase-tools` reports an auth/permission
  error** — `FIREBASE_SERVICE_ACCOUNT` is missing, truncated, or from the
  wrong project. Re-download a fresh key from Console step 4.
- **A Firestore rules deploy fails with a 403 "does not have permission"
  on `databases?databaseId=(default)`** — the Firestore database itself
  hasn't been created yet. Go back to step 1 and create it in the Console
  first; this is expected, not a bug, and is why database creation is never
  automated here.
- **The app works fine but session history never appears in Firestore** —
  check that `public/js/firebase-config.js` exists and doesn't still contain
  `'REPLACE_ME'` placeholder values, and check your browser console for a
  `[chess-clock-timer]` warning explaining what failed. The app is designed
  to degrade silently to local-only history, so this is never a hard error.
