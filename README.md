# Car Maintenance Tracker

Self-hosted, lightweight tracker for a shared car. Drivers snap dashboard photos before and after each ride and upload service invoices. Admins review everything on a desktop view and subscribe to a calendar feed.

Stack: Node.js 20+ (Express), SQLite (WAL), vanilla JS with Tailwind CDN, Gemini `gemini-3.5-flash-lite` for vision and invoice OCR, Nginx for TLS.

## Run locally

```bash
git clone https://github.com/WillYouth/car-maintenance-tracker.git
cd car-maintenance-tracker
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

Assumes Ubuntu 22.04 or 24.04 with Node.js 20 or 22. Check with `node -v` and `which node`; the systemd unit expects Node at `/usr/bin/node`, which is where NodeSource and the Ubuntu packages install it.

Before you start, have these ready:

- The subdomain `car.domain.com` pointing at your public IP (an A record).
- A DNS API token for your provider, for the certificate. The example uses Cloudflare.
- Your Gemini API key.

```bash
# 1. Packages and a service user (no -m: git clone needs an empty target directory)
sudo apt update && sudo apt install -y nginx certbot git sqlite3
sudo useradd -r -d /opt/car-maintenance-tracker -s /usr/sbin/nologin carapp

# 2. Get the code and hand it to the service user
sudo git clone https://github.com/WillYouth/car-maintenance-tracker.git /opt/car-maintenance-tracker
sudo chown -R carapp:carapp /opt/car-maintenance-tracker
sudo chmod 755 /opt/car-maintenance-tracker        # Nginx (www-data) must be able to traverse this directory
cd /opt/car-maintenance-tracker && sudo -u carapp npm ci --omit=dev

# 3. Configuration: .env owned by carapp, readable only by it
sudo -u carapp cp .env.example .env
sudo -u carapp chmod 600 .env
sudo -u carapp nano .env                            # set GEMINI_API_KEY and PUBLIC_URL=https://car.domain.com

# 4. First admin account (the password never lands in shell history)
read -rs PASSWORD && export PASSWORD
sudo -E -u carapp node scripts/cli.js add-user you@example.com "Your Name" admin
unset PASSWORD

# 5. Run as a service with restart-on-failure and a memory cap
sudo cp deploy/car-maintenance-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now car-maintenance-tracker
systemctl status car-maintenance-tracker --no-pager
curl -s http://127.0.0.1:3000/api/auth/me           # expect {"error":"Sign in required"}

# 6. TLS certificate via DNS-01, so port 80 does not need to be public
sudo apt install -y python3-certbot-dns-cloudflare  # or your provider's plugin
sudo nano /root/cloudflare.ini                      # one line: dns_cloudflare_api_token = YOUR_TOKEN
sudo chmod 600 /root/cloudflare.ini
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/cloudflare.ini -d car.domain.com

# 7. Nginx: site config plus the shared proxy snippet
sudo cp deploy/nginx.conf /etc/nginx/sites-available/car-maintenance-tracker
sudo cp deploy/car-maintenance-tracker-proxy.conf /etc/nginx/snippets/car-maintenance-tracker-proxy.conf
sudo ln -s /etc/nginx/sites-available/car-maintenance-tracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then:

- **Router:** forward TCP 443 to the server. Port 80 only needs forwarding if you switch to HTTP-01 challenges.
- **Firewall:** if `ufw` is enabled, run `sudo ufw allow 443/tcp`.
- **Open the app:** `https://car.domain.com`, and sign in with the admin account from step 4.

If the GitHub repository is private, step 2 needs access for the server: a GitHub deploy key or a token in the clone URL.

### Updating a deployed version

```bash
cd /opt/car-maintenance-tracker
sudo -u carapp git pull
sudo -u carapp npm ci --omit=dev
sudo systemctl restart car-maintenance-tracker
```

`.env` and `data/` are not in git, so updates never touch your key or your database.

## Operations

- **Backups:** a daily cron job, for example `sudo -u carapp sqlite3 /opt/car-maintenance-tracker/data/app.db ".backup '/var/backups/car-$(date +%F).db'"`. Also back up `/opt/car-maintenance-tracker/data/uploads/`.
- **Add a driver:** use the Drivers panel in the admin view.
- **Logs:** `journalctl -u car-maintenance-tracker -f` and `/var/log/nginx/car-maintenance-tracker.error.log`.
- **Memory:** the unit caps the process at 192 MB. Typical RSS is 40–70 MB.
- **Gemini quota:** the free tier has daily request limits per model. When the quota runs out, photos are still saved and drivers enter the numbers by hand.

## Layout

```
public/index.html                          SPA shell (Tailwind CDN)
public/app.js                              Driver + admin UI, client-side image compression
src/server.js                              Express bootstrap, calendar route, error handling
src/routes.js                              REST API (auth, rides, maintenance, admin)
src/config.js                              Environment config (loads .env and .env.local)
src/gemini.js                              Dashboard and invoice prompts, schemas, normalization
src/lib/gemini/client.js                   Gemini SDK client and model name
src/lib/gemini/index.js                    generateText / generateJson with 503/504 retry
src/auth.js                                Cookie sessions (hashed tokens), login throttle
src/db.js                                  SQLite connection and pragmas
src/schema.sql                             Database schema
src/notify.js                              Telegram + SMTP alerts
src/ics.js                                 iCalendar feed generation
scripts/cli.js                             CLI for bootstrap accounts
scripts/gemini-smoke.js                    Gemini connectivity check (npm run gemini:smoke)
deploy/nginx.conf                          TLS, static files, reverse proxy, rate limit
deploy/car-maintenance-tracker-proxy.conf  Proxy settings included by nginx.conf
deploy/car-maintenance-tracker.service     systemd unit
```

## Notes

- Gemini is optional at runtime. Without `GEMINI_API_KEY`, photos are still stored and drivers enter the numbers by hand.
- The OCR can misread odometer digits and warning lights. The driver's verification screen is the check, so don't let photo readings update records without it.
- The calendar feed URL contains a secret token. Rotate it from the admin view if it leaks.
