# Car Maintenance Tracker

Self-hosted, lightweight tracker for a shared car. Drivers snap dashboard photos before and after each ride and upload service invoices. Admins review everything on a desktop view and subscribe to a calendar feed.

Stack: Node.js 20+ (Express), SQLite (WAL), vanilla JS with Tailwind CDN, Gemini `gemini-3.5-flash-lite` for vision and invoice OCR, Nginx for TLS.

## Run locally

```bash
cd car-tracker
npm install
cp .env.example .env          # then put your real GEMINI_API_KEY in .env
npm run gemini:smoke          # optional: checks the Gemini key
npm run dev                   # starts on http://127.0.0.1:3000
```

Create the first admin account before signing in:

```bash
read -rs PASSWORD && export PASSWORD
node scripts/cli.js add-user you@example.com "Your Name" admin
unset PASSWORD
```

The server binds to `127.0.0.1` only, so the app is reachable from this machine at `http://localhost:3000`. Phone cameras need HTTPS, so use the Ubuntu deployment below for real use.

## Deploy on Ubuntu

Assumes Ubuntu 22.04+ with Node.js 20 or 22 installed (`node -v`). If Node isn't installed, use NodeSource or the distro package.

```bash
# 1. Packages and a locked-down service user
sudo apt update && sudo apt install -y nginx certbot
sudo useradd -r -m -d /opt/car-tracker -s /usr/sbin/nologin carapp
sudo chmod 755 /opt/car-tracker          # Nginx (www-data) must traverse this directory

# 2. Copy the app and hand ownership to the service user
sudo rsync -a --exclude node_modules --exclude .env --exclude data ./ /opt/car-tracker/
sudo chown -R carapp:carapp /opt/car-tracker
sudo -u carapp npm ci --omit=dev         # builds better-sqlite3 for this CPU (prebuilt for arm64/x64)

# 3. Configuration: create .env on the server, owned by carapp, readable only by it
sudo -u carapp cp /opt/car-tracker/.env.example /opt/car-tracker/.env
sudo -u carapp chmod 600 /opt/car-tracker/.env
sudo -u carapp nano /opt/car-tracker/.env   # set GEMINI_API_KEY, PUBLIC_URL, optional alerts

# 4. First admin account (the password never lands in shell history)
read -rs PASSWORD && export PASSWORD
sudo -E -u carapp node /opt/car-tracker/scripts/cli.js add-user you@example.com "Your Name" admin
unset PASSWORD

# 5. Run as a service with restart-on-failure and a memory cap
sudo cp /opt/car-tracker/deploy/car-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now car-tracker
systemctl status car-tracker --no-pager
curl -s http://127.0.0.1:3000/api/auth/me    # expect {"error":"Sign in required"}

# 6. TLS certificate via DNS-01 (port 80 does not need to be public).
#    Install the plugin for your DNS provider, then request the certificate:
sudo apt install -y python3-certbot-dns-cloudflare   # or your provider's plugin
sudo mkdir -p /etc/letsencrypt
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/cloudflare.ini -d cars.example.com

# 7. Nginx: site config plus the shared proxy snippet
sudo cp /opt/car-tracker/deploy/nginx.conf /etc/nginx/sites-available/car-tracker
sudo cp /opt/car-tracker/deploy/car-tracker-proxy.conf /etc/nginx/snippets/car-tracker-proxy.conf
sudo ln -s /etc/nginx/sites-available/car-tracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then, on your router, forward TCP 443 to the server. Port 80 only needs forwarding if you switch to HTTP-01 certificate challenges.

Replace `cars.example.com` in `deploy/nginx.conf` and `PUBLIC_URL` in `.env` with your domain. The `cloudflare.ini` file holds your DNS API token; the example assumes Cloudflare, so use your provider's plugin and credentials instead.

### Updating a deployed version

```bash
sudo rsync -a --exclude node_modules --exclude .env --exclude data ./ /opt/car-tracker/
sudo chown -R carapp:carapp /opt/car-tracker
sudo -u carapp npm ci --omit=dev
sudo systemctl restart car-tracker
```

## Operations

- **Backups:** `sudo -u carapp sqlite3 /opt/car-tracker/data/app.db ".backup '/var/backups/car-$(date +%F).db'"` from a daily cron job. Also back up `/opt/car-tracker/data/uploads/`.
- **Add a driver:** use the Drivers panel in the admin view.
- **Logs:** `journalctl -u car-tracker -f` and `/var/log/nginx/car-tracker.error.log`.
- **Memory:** the unit caps the process at 192 MB. Typical RSS is 40–70 MB.
- **Gemini quota:** the free tier has daily request limits per model. When the quota runs out, photos are still saved and drivers enter the numbers by hand.

## Layout

```
public/index.html              SPA shell (Tailwind CDN)
public/app.js                  Driver + admin UI, client-side image compression
src/server.js                  Express bootstrap, calendar route, error handling
src/routes.js                  REST API (auth, rides, maintenance, admin)
src/config.js                  Environment config (loads .env and .env.local)
src/gemini.js                  Dashboard and invoice prompts, schemas, normalization
src/lib/gemini/client.js       Gemini SDK client and model name
src/lib/gemini/index.js        generateText / generateJson with 503/504 retry
src/auth.js                    Cookie sessions (hashed tokens), login throttle
src/db.js                      SQLite connection and pragmas
src/schema.sql                 Database schema
src/notify.js                  Telegram + SMTP alerts
src/ics.js                     iCalendar feed generation
scripts/cli.js                 CLI for bootstrap accounts
scripts/gemini-smoke.js        Gemini connectivity check (npm run gemini:smoke)
deploy/nginx.conf              TLS, static files, reverse proxy, rate limit
deploy/car-tracker-proxy.conf  Proxy settings included by nginx.conf
deploy/car-tracker.service     systemd unit
```

## Notes

- Gemini is optional at runtime. Without `GEMINI_API_KEY`, photos are still stored and drivers enter the numbers by hand.
- The OCR can misread odometer digits and warning lights. The driver's verification screen is the check, so don't let photo readings update records without it.
- The calendar feed URL contains a secret token. Rotate it from the admin view if it leaks.
