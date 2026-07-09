# ChatGPT Bridge - local subscription mode

This is a local-only workaround for using your normal ChatGPT web subscription
with the CSIR Note Sheet app. It opens a visible browser, lets you log in to
ChatGPT normally, then exposes:

```text
http://localhost:8790/generate
```

Use that URL as the app Backend URL.

## Important Limits

- This is not an official API.
- It must run on your own computer.
- It depends on the ChatGPT web UI and can break if the UI changes.
- It does not bypass login, CAPTCHA, rate limits, or plan limits.
- It is not suitable for a shared/public VPS backend.

## Setup On Windows

```powershell
cd "C:\Users\HP\VIkash\Data bento\Csir-noting\chatgpt-bridge"
npm.cmd install
npm.cmd start
```

The bridge opens Chrome/Chromium. Log in to `chatgpt.com` in that browser if
asked. Keep the terminal and browser open while using the note app.

In the note app:

1. Click the settings button at bottom-left.
2. Click `Local ChatGPT`, or manually set Backend URL to:

```text
http://localhost:8790/generate
```

3. Save and retry generation/refinement.

## If Browser Launch Fails

Install Playwright's bundled browser:

```powershell
npm.cmd run install-browser
npm.cmd start
```

To force Playwright Chromium instead of installed Chrome:

```powershell
$env:CHATGPT_BROWSER_CHANNEL=""
npm.cmd start
```
