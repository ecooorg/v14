# Bifurcation Engine v14

Personal thinking tool based on the “Before You Choose” method.

## Structure

```
/
├── app/       client (React)
├── server/    Express API
├── public/    static assets
├── docs/
└── (root config files)
```

## Setup

```bash
cp .env.example .env
# Set SESSION_SECRET, TESTER_CODES, GEMINI_API_KEY
npm install
npm run dev
```

## Storage modes

At first launch the user chooses:

- **No reliable storage** — session only; continuation is not guaranteed
- **Google Drive** — dialogs saved to the user’s personal Drive

The app server never stores dialogs.

## Scripts

- `npm run dev` — development
- `npm run build && npm start` — production
- `npm run check` — lint:copy + core tests
