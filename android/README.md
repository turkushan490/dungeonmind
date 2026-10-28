# DungeonMind for Android

A small [Capacitor](https://capacitorjs.com) app around DungeonMind. It opens your own DungeonMind server in a full-screen WebView, so it runs **the same React app** as the browser, with an Android layout (bottom tab bar, no browser chrome).

> This was meant to live in its own repository (`turkushan490/dungeonmind-android`), but the build session couldn't create repositories, so it lives here in `android/`. Moving it out later is a plain `git subtree split --prefix android`.

- **First start:** enter your server address (e.g. `https://dm.example.com` or `http://192.168.1.20:4830`). It's checked against `/api/health` and remembered; recent servers are listed.
- **Login:** on the server's own login page, so both `AUTH_MODE=builtin` and `AUTH_MODE=header` (your forward-auth portal) work. Settings → **Change server** goes back to the picker.
- **No push, no Firebase:** notices stay in the app (lobby invites, toasts).
- Plain `http://` LAN servers work (cleartext is allowed for self-hosting).

## Build

GitHub Actions builds the APK (`.github/workflows/android.yml`) on every change under `android/` and on version tags; tags attach the APK to the GitHub Release. Download it from the workflow run's artifacts or the release page and install it (allow "install unknown apps").

A **signed release APK** is built too when the repository has these secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them you get the debug-signed APK, which installs fine for personal use.

Locally (Android SDK + JDK 21):

```bash
cd android
npm ci
npm run apk        # → android/app/build/outputs/apk/debug/app-debug.apk
```

`render-icons.cjs` renders the launcher icons from `www/icon.svg` (needs Playwright).
