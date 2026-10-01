# Life OS

A personal Life OS: a training log, an AI assistant that reads it and (with approval) writes to it, and a heads-up display meant to stay open all day. The assistant also keeps documents and deadlines, remembers facts it is told, reads the news, and can be spoken to.

This is a point-in-time snapshot shared for reference. It is not maintained, and it does not take issues or pull requests.

## Stack

- `backend/`: Laravel 13 API (PHP 8.4, SQLite)
- `app/`: Expo SDK 54 with React Native Web. Web is the only target.

## Running your own copy

Everything runs on your machine with your own keys. Nothing here connects to anyone else's data.

1. Copy `backend/.env.example` to `backend/.env`. Fill in `ANTHROPIC_API_KEY` and the four sign-in settings: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and `AUTH_OWNER_EMAIL`. The owner email is your own Google account. Left blank, it lets nobody in.
2. In `backend/`: `composer install`, `php artisan key:generate`, `php artisan migrate`.
3. In `app/`: `npm ci`, then `npx expo start --web --port 8082`. Set `EXPO_PUBLIC_API_BASE` and `EXPO_PUBLIC_APP_URL` if your hosts differ from the defaults.
4. The chat loop and scheduled features need a queue worker and the scheduler running.

`CLAUDE.md` has the full setup, written for Windows with Laravel Herd, and the reasoning behind each design decision. Some of it describes one particular machine.

## Tests

- Backend: `php artisan test` in `backend/`
- Frontend: `npx jest` in `app/`
