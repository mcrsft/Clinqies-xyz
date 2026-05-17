# clinqies.xyz — deployment guide

## server requirements
- Ubuntu 24.04 LTS (recommended)
- 1+ vCPU, 1GB+ RAM, 1TB+ disk
- Node.js 20+, Nginx, Certbot

---

## 1. provision the server

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs nginx certbot python3-certbot-nginx python3

# Create app user and directories
mkdir -p /var/www/clinqies/{data,uploads,backend,frontend}
chown -R www-data:www-data /var/www/clinqies
```

---

## 2. DNS setup

Point these records at your VPS IP:

```
A     clinqies.xyz       → <your-vps-ip>
A     www.clinqies.xyz   → <your-vps-ip>
```

Wait for propagation before running Certbot.

---

## 3. deploy the app

```bash
# Copy project files to server (from your local machine)
rsync -av --exclude node_modules . root@<vps-ip>:/var/www/clinqies/

# On the server — install dependencies
cd /var/www/clinqies/backend
npm install --production

# Set up environment
cp .env.example .env
nano .env  # fill in JWT_SECRET and verify paths

# Generate JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# paste output into .env as JWT_SECRET
```

---

## 4. set permissions

```bash
chown -R www-data:www-data /var/www/clinqies
chmod 750 /var/www/clinqies/data
chmod 755 /var/www/clinqies/uploads
chmod 640 /var/www/clinqies/backend/.env
```

---

## 5. Nginx config

```bash
cp nginx/clinqies.xyz.conf /etc/nginx/sites-available/clinqies.xyz
ln -s /etc/nginx/sites-available/clinqies.xyz /etc/nginx/sites-enabled/

# Add rate limit zone to http block in /etc/nginx/nginx.conf:
# limit_req_zone $binary_remote_addr zone=upload:10m rate=5r/s;

nginx -t && systemctl reload nginx
```

---

## 6. SSL with Certbot

```bash
certbot --nginx -d clinqies.xyz -d www.clinqies.xyz
# Follow prompts, select redirect option

# Auto-renewal
systemctl enable certbot.timer
```

---

## 7. systemd service

```bash
cp clinqies.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable clinqies
systemctl start clinqies

# Check status
systemctl status clinqies
journalctl -u clinqies -f
```

---

## 8. create first admin + invite

The first registered user is automatically promoted to admin.
Generate your first invite with the Python admin tool:

```bash
cd /var/www/clinqies/scripts
DB_PATH=/var/www/clinqies/data/clinqies.db python3 admin.py create-invite

# Output:
# Generated 1 invite code(s):
#   abc123xyz...
```

Go to https://clinqies.xyz → click "create account" → use the invite code.

---

## 9. ShareX setup

1. Log in to clinqies.xyz
2. Go to **Settings → ShareX / API**
3. Click **download sharex .sxcu**
4. In ShareX: Destinations → Custom Uploaders → Import → select the downloaded file
5. Set as active uploader for images/files

---

## admin tools (Python)

```bash
cd /var/www/clinqies/scripts
export DB_PATH=/var/www/clinqies/data/clinqies.db
export UPLOAD_DIR=/var/www/clinqies/uploads

# Generate invites
python3 admin.py create-invite --count 5 --expires-days 7

# List users
python3 admin.py list-users

# Storage report
python3 admin.py storage-report

# Promote to admin
python3 admin.py set-admin <username>

# Remove orphan files from disk
python3 admin.py clean-orphans
```

---

## directory structure

```
/var/www/clinqies/
├── backend/          ← Node.js Express app
│   ├── server.js
│   ├── .env          ← secrets (600 perms)
│   ├── routes/
│   ├── middleware/
│   └── utils/
├── frontend/
│   └── public/       ← static files served by Express
│       └── index.html
├── uploads/          ← user-uploaded files (www-data owned)
├── data/
│   └── clinqies.db   ← SQLite database
└── scripts/
    └── admin.py      ← Python admin utilities
```

---

## updates

```bash
# Pull new code
cd /var/www/clinqies
git pull  # or rsync from local

# Restart service
cd backend && npm install --production
systemctl restart clinqies
```

---

## backup

```bash
# Simple cron backup (add to root crontab)
# crontab -e
0 3 * * * cp /var/www/clinqies/data/clinqies.db /backups/clinqies-$(date +\%Y\%m\%d).db
```
