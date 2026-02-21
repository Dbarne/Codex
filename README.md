# Wedding Photo Collector

A simple website for wedding guests to upload photos with these rules:

- Each guest enters their name and can upload up to **10 photos total**.
- The whole gallery accepts up to **600 photos total**.
- You and your partner can log in as admins to view all photos and who uploaded each one.
- A QR code is shown on the homepage so guests can scan and upload quickly.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env template:
   ```bash
   cp .env.example .env
   ```
3. Edit `.env`:
   - Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`
   - Set a strong `SESSION_SECRET`
   - Set `BASE_URL` to your public domain/tunnel URL (recommended)

## Run locally

```bash
npm start
```

Open: [http://localhost:3000](http://localhost:3000)

## Expose a public endpoint for guests

You must use a public domain or tunnel so guests can reach the upload page.

### Option A: Deploy to a host (recommended)

Deploy this app to Render, Railway, Fly.io, etc. Then set:

- `BASE_URL=https://your-public-domain`

#### Render quick setup

1. Push this repo to GitHub.
2. In Render: **New +** -> **Blueprint**.
3. Select this repo. Render will detect `render.yaml`.
4. Fill required env vars:
   - `BASE_URL` (your Render URL, e.g. `https://your-service.onrender.com`)
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
5. Deploy.

This project is configured to persist uploads + SQLite data on a Render disk:
- `DATA_DIR=/var/data/data`
- `UPLOAD_DIR=/var/data/uploads`

### Option B: Use a temporary tunnel from your machine

Example with Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then copy the generated `https://...trycloudflare.com` URL into `BASE_URL` and restart the app.

## Admin

- Login URL: `/admin/login`
- Use `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`.

## Notes

- Uploaded files are stored in `uploads/`.
- Metadata is stored in `data/wedding-photos.db`.
- The QR code uses `BASE_URL` when set; otherwise it uses the current request host (works behind tunnels/proxies).
- In production, use HTTPS and keep `.env` secrets private.
