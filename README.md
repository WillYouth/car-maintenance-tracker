# Car Maintenance Tracker

Self-hosted, lightweight tracker for a shared car. Drivers snap dashboard photos before and after each ride and upload service invoices. Admins review everything on a desktop view and subscribe to a calendar feed.

Stack: Node.js 22 LTS (Express), SQLite (WAL), vanilla JS with Tailwind CDN, Gemini `gemini-3.5-flash-lite` for vision and invoice OCR, Nginx for TLS.

## Run locally

Requires Node.js 20.6 or newer. Node 22 LTS is recommended; see step 1 of the Ubuntu section for installing it.

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

## Deploy on Ubuntu 22.04

Target: Ubuntu 22.04.5 LTS (x86_64 or arm64). Run everything as a user with `sudo` rights.

Before you start, have these ready:

- An A record for `car.domain.com` pointing at your public IP.
- A DNS API token for your provider, for the certificate. The example uses Cloudflare.
- Your Gemini API key.

### 1. Install Node.js 22 LTS

Ubuntu 22.04's own `nodejs` package is version 12, which is too old for this app. Use NodeSource's signed apt repository, which installs Node to `/usr/bin/node`, the path the systemd unit expects:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install -y nodejs

node -v        # expect v22.x
which node     # expect /usr/bin/node
npm -v
```

Node 22 is an LTS release, so it receives security updates through the same repository (`sudo apt update && sudo apt upgrade nodejs`).

### 2. Install system packages and create the service user

```bash
sudo apt install -y nginx certbot git sqlite3
sudo useradd -r -d /opt/car-maintenance-tracker -s /usr/sbin/nologin carapp
```

The service user is created without `-m` so that `git clone` gets an empty target directory.

### 3. Get the code

```bash
sudo git clone https://github.com/WillYouth/car-maintenance-tracker.git /opt/car-maintenance-tracker
sudo chown -R carapp:carapp /opt/car-maintenance-tracker
sudo chmod 755 /opt/car-maintenance-tracker     # Nginx (www-data) must be able to traverse this directory
cd /opt/car-maintenance-tracker && sudo -u carapp npm ci --omit=dev
```

`npm ci` installs `better-sqlite3`, which ships prebuilt binaries for Node 22 on x86_64 and arm64. If it reports a build error (for example, when it can't download the binary), install the build tools and run the same command again:

```bash
sudo apt install -y build-essential python3
cd /opt/car-maintenance-tracker && sudo -u carapp npm ci --omit=dev
```

### 4. Configure the environment

```bash
cd /opt/car-maintenance-tracker
sudo -u carapp cp .env.example .env
sudo -u carapp chmod 600 .env
sudo -u carapp nano .env     # set GEMINI_API_KEY and PUBLIC_URL=https://car.domain.com
```

`PUBLIC_URL` must match the address you'll open in the browser, because it's used for the calendar feed link. Telegram and SMTP alerts are optional.

### 5. Create the first admin account

```bash
cd /opt/car-maintenance-tracker
read -rs PASSWORD && export PASSWORD
sudo -E -u carapp node scripts/cli.js add-user you@example.com "Your Name" admin
unset PASSWORD
```

The password is read silently and never written to shell history.

### 6. Run the app as a service

```bash
sudo cp /opt/car-maintenance-tracker/deploy/car-maintenance-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now car-maintenance-tracker
systemctl status car-maintenance-tracker --no-pager
curl -s http://127.0.0.1:3000/api/auth/me     # expect {"error":"Sign in required"}
```

The unit restarts the app on failure and caps its memory at 192 MB.

### 7. Get a TLS certificate

The certificate uses a DNS challenge, so port 80 doesn't need to be open to the internet. The example uses the Cloudflare plugin; install the plugin for your provider instead if you use a different one.

```bash
sudo apt install -y python3-certbot-dns-cloudflare
sudo nano /root/cloudflare.ini          # one line: dns_cloudflare_api_token = YOUR_TOKEN
sudo chmod 600 /root/cloudflare.ini
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/cloudflare.ini -d car.domain.com
```

Ubuntu 22.04's certbot package is older than the snap version, but it renews certificates automatically through a systemd timer. Check that with `systemctl list-timers | grep certbot`.

### 8. Configure Nginx

```bash
sudo cp /opt/car-maintenance-tracker/deploy/nginx.conf /etc/nginx/sites-available/car-maintenance-tracker
sudo cp /opt/car-maintenance-tracker/deploy/car-maintenance-tracker-proxy.conf /etc/nginx/snippets/car-maintenance-tracker-proxy.conf
sudo ln -s /etc/nginx/sites-available/car-maintenance-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The config uses `listen ... http2`, which is the syntax Ubuntu 22.04's nginx 1.18 understands.

### 9. Open the network

- **Router:** forward TCP 443 to this server's LAN address. Port 80 only needs forwarding if you change to HTTP-01 challenges.
- **Firewall:** if `ufw` is enabled, allow the web ports and SSH before enabling it:

  ```bash
  sudo ufw allow OpenSSH
  sudo ufw allow 'Nginx Full'
  sudo ufw enable
  ```

- **Open the app:** go to `https://car.domain.com` and sign in with the admin account from step 5.

If the GitHub repository is private, step 3 needs access for the server: a GitHub deploy key or a token in the clone URL.

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
