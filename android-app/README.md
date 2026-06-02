# CSIR Note Sheet — Android app

This folder wraps the web app (`../NoteSheetGenerator.jsx`) into a real Android
app using **Capacitor**. Same screens and features as the web version.

## 📲 How to get the installable app (.apk) — no tools needed

The app is built **automatically in the cloud** by GitHub Actions. To get it:

1. Open the repository on GitHub → **Actions** tab.
2. Click the most recent **"Build Android APK"** run (green ✓ means it finished).
3. Scroll to **Artifacts** → download **`CSIR-Note-Sheet-debug-apk`**.
4. Unzip it to get **`app-debug.apk`**, copy it to an Android phone, and open it.
   - The phone will ask to allow installing from this source — accept it
     (this is normal for apps not from the Play Store).

A new APK is built every time the app code changes, or you can start a build
manually from the Actions tab → **Build Android APK** → **Run workflow**.

## 🤖 Turning on real AI

The app works in **demo mode** out of the box (realistic sample responses), so
you can try every screen offline.

To enable real AI note-writing, tap the **⚙ button** (bottom-left) inside the
app and paste an **Anthropic API key** from <https://console.anthropic.com>.
The key is stored only on the phone. (A Claude Max subscription cannot be used
here — a standalone app needs an API key, which is billed separately.)

## 🛠 Building locally (optional, for developers)

Requires Node.js, JDK 17, and the Android SDK.

```bash
cd android-app
npm install
npm run build:apk      # builds web assets, syncs, and runs gradle assembleDebug
# APK appears at: android/app/build/outputs/apk/debug/app-debug.apk
```
