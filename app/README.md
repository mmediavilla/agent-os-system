# Life OS — Frontend

Expo SDK 54 + React Native Web app for the Life OS personal dashboard. Runs on iOS, Android, and web from a single codebase.

## Prerequisites

- **Node.js ≥ 18** — [nodejs.org](https://nodejs.org) · manage versions with [fnm](https://github.com/Schniz/fnm) (all platforms) or [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux)
- **npm** — bundled with Node
- **Expo CLI** — no global install needed; all commands use `npx`

Platform-specific extras:

| Target | Extra requirement |
|--------|-------------------|
| Web | Just a browser |
| Android | [Android Studio](https://developer.android.com/studio) + Android SDK |
| iOS | Xcode (macOS only) |

## Install

```bash
npm install
```

## Configure API endpoint

The app reads the backend URL from the `EXPO_PUBLIC_API_BASE` environment variable. The default local dev setup uses a Herd custom domain; an `.env` file in this folder sets it:

```bash
EXPO_PUBLIC_API_BASE=https://projectmc.test/api
```

To override, create an `.env.local` file (takes precedence over `.env`):

```bash
EXPO_PUBLIC_API_BASE=http://your-host:8001/api
```

Expo picks up both files automatically — no code changes needed.

## Run

### Web (recommended for local dev)

```bash
npx expo start --web --port 8082
```

Opens at **https://projectmc-app.test** (Herd proxies that domain to port 8082) or directly at **http://localhost:8082**.

> **Note:** Herd handles the domain and SSL, but Expo must be running. A 502 at `projectmc-app.test` means the dev server isn't started yet.

### Android

```bash
npm run android
```

Requires an Android emulator running or a physical device connected via USB.

### iOS

```bash
npm run ios
```

Requires Xcode installed (macOS only).

### All-platforms picker

```bash
npm start
```

Opens the Expo developer menu — press `w` for web, `a` for Android, `i` for iOS.

## Project structure

```
app/
  App.tsx          Root component
  index.ts         Entry point
  src/
    api.ts         API client — all backend calls live here
    screens/
      Dashboard.tsx  Main overview screen
      Fitness.tsx    Workout logging and AI insights
    theme.ts       Design tokens (colors, spacing, typography)
  assets/          App icons and splash screen
```

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `expo start` | All-platforms dev server |
| `npm run web` | `expo start --web --port 8082` | Web only |
| `npm run android` | `expo start --android` | Android only |
| `npm run ios` | `expo start --ios` | iOS only |
