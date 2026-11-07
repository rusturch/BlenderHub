# Privacy Policy — Blender Hub

Last updated: November 7, 2026

Blender Hub is a desktop launcher for Blender. It runs entirely on your computer.

## What the app stores

All launcher data — settings, themes, tracked projects, installed Blender builds, the add-on
library — lives in the `data/` folder next to the launcher executable. Nothing is uploaded
anywhere by default.

## Cloud sync (optional)

- If you enable Cloud sync and sign in with Google, the launcher stores its sync data
  (interface preferences and themes — a few kilobytes of JSON) in the hidden application data
  folder of **your own Google Drive** (`drive.appdata` scope).
- That scope only grants access to the app's own hidden folder. The launcher cannot see, read
  or modify any other files in your Google Drive.
- There are no Blender Hub servers. Sync data never leaves your Google account, and the
  developer never receives it.
- The Google sign-in token is stored on your computer, encrypted by your operating system, and
  is only ever sent to Google's own APIs.
- You can disable sync at any time, delete the synced data from the app
  (Settings → Cloud sync → Delete cloud data), or revoke the launcher's access to your Google
  account entirely at <https://myaccount.google.com/connections>.

## Telemetry

The launcher contains no analytics, tracking or telemetry. It makes network requests only to:

- blender.org services — version catalogs and build downloads;
- extensions.blender.org and superhivemarket.com — add-ons you explicitly request;
- github.com — checking for launcher updates;
- Google Drive API — cloud sync, only if you enabled it.

## Contact

Questions about this policy: open an issue on this repository or email rus.turch@gmail.com.
