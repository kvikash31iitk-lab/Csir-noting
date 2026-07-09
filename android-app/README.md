# CSIR Note Sheet - Android app

This folder wraps the web app (`../NoteSheetGenerator.jsx`) into an Android app
using Capacitor. It has the same screens and features as the web version.

## How To Get The Installable APK

The app is built automatically in the cloud by GitHub Actions.

1. Open the repository on GitHub, then the Actions tab.
2. Click the most recent "Build Android APK" run.
3. Download the `CSIR-Note-Sheet-debug-apk` artifact.
4. Unzip it to get `app-debug.apk`, copy it to an Android phone, and open it.

## Turning On Real AI

The app works in demo mode out of the box with realistic sample responses.

For real AI note-writing, use the `note-api` backend configured with
`OPENAI_API_KEY`. Tap the settings button in the app, set the backend URL, and
sign in.

The settings panel also includes an OpenAI API-key field for device-local
testing. For production/internal use, the backend URL is recommended so the API
key stays on the server.

## Building Locally

Requires Node.js, JDK 17, and the Android SDK.

```bash
cd android-app
npm install
npm run build:apk
```

The APK appears at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```
