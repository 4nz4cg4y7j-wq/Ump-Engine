# Officials Engine

Officials Engine is now set up as a Node/Express app for Render.

## Files

- `server.js` - Express backend, auth routes, dashboard APIs, Postgres schema setup.
- `package.json` - Render build/start commands and dependencies.
- `render.yaml` - Render blueprint for the web service and Postgres database.
- `index.html`, `pricing.html`, `login.html`, `register.html`, `dashboard.html` - frontend pages served by Express.

## Render Setup

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint or Web Service from the repo.
3. If using the blueprint, Render will read `render.yaml` and create:
   - `officials-engine` web service
   - `officials-engine-db` Postgres database
4. Confirm these environment variables exist on the web service:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `NODE_ENV=production`
5. Deploy.

## Local Development

Install dependencies:

```bash
npm install
```

Set a local Postgres `DATABASE_URL`, then run:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Current Backend Features

- User registration and login with hashed passwords.
- Secure HTTP-only session cookie.
- Dashboard auth protection.
- Create static tournament groups.
- Add static/manual umpires to a group.
- Add single games.
- Bulk import pasted schedules.
- Assign umpires to games.
