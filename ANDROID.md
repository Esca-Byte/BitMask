# BitMask Android APK

BitMask uses Capacitor to package the existing web interface into an Android APK. The interface is bundled into the APK; messages, rooms, encrypted file relay, and call signaling still use the hosted Node.js/Socket.IO service.

## Render setup

Create a Render **Web Service** from this repository. `render.yaml` contains the baseline configuration:

- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/api/health`

Set these Render environment variables:

```env
MAX_FILE_SIZE=26214400
CORS_ORIGINS=https://bitmask-lpf2.onrender.com,capacitor://localhost,https://localhost
```

Use the exact public Render URL for `CORS_ORIGINS`. Keep the service on HTTPS so the browser version, Android WebView, camera, microphone, and WebRTC signaling remain secure.

## Configure the APK backend

Before creating a release APK, open `public/js/config.js` and set:

```js
const RENDER_SERVER_URL = 'https://bitmask-lpf2.onrender.com';
```

The Android app uses this URL while the web app uses its current origin automatically.

## Android build requirements

- Android Studio with Android SDK 36
- JDK 21 or newer
- Android SDK Build Tools installed
- An Android device or emulator for testing

The current worker environment has Java 8 and no Android SDK, so it can generate and sync the Android project but cannot produce the final APK here.

## Commands

Install dependencies and create/sync the Android project:

```bash
npm ci
npx cap sync android
```

Open in Android Studio:

```bash
npm run android:open
```

Build with the Capacitor CLI:

```bash
npm run android:build
```

Or build directly from Android Studio/Gradle. The debug APK is typically written under:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

The release APK must be signed with a keystore that you control before sharing it.

## Android capabilities included

- Native QR scanning through `@capacitor/barcode-scanner`
- Camera and microphone permissions for calls
- Bundled local web interface
- Render HTTPS/WSS backend connection
- Existing encrypted messages, rooms, media chunks, replies, reactions, and call cancellation flow

## Manual release checklist

1. Set `RENDER_SERVER_URL` in `public/js/config.js`.
2. Set restrictive `CORS_ORIGINS` on Render.
3. Run `npm ci` and `npx cap sync android`.
4. Build and install the debug APK on two Android devices.
5. Test peer connection, group room, encrypted image, QR scan, voice call, video call, rejection, cancellation, timeout, and reconnect.
6. Test the APK with the Render service while the web app is also open.
7. Create a signed release APK and keep the keystore backed up.
