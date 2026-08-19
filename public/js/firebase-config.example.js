// Copy this file to `firebase-config.js` (same folder) and paste in the
// `firebaseConfig` object shown by Firebase Console → Project settings →
// General → "Your apps" → Web app → SDK setup and configuration.
//
// `firebase-config.js` is gitignored on purpose — real project config is
// not secret (it ships in any client bundle regardless), but keeping it out
// of git means anyone cloning this repo starts with Firebase history
// disabled by default, which is exactly what "guest/local history works
// without login and without Firebase" requires. See FIREBASE_SETUP.md.
//
// The app works completely normally with no `firebase-config.js` present —
// history is simply kept locally only, and this module is never imported.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};
