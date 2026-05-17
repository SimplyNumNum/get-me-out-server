# Deploying the Relay Server (Railway)

Railway gives you a free hosted server so your friends can connect from
anywhere — no port forwarding, no "host it on your machine" required.

---

## Step 1 — Push the server to GitHub

You need a separate GitHub repo just for the server files.

1. Go to https://github.com and sign in (create an account if needed)
2. Click **New repository**, name it `get-me-out-server`, make it **Public**, click Create
3. Open a terminal in your `server/` folder and run:

```
git init
git add .
git commit -m "initial server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/get-me-out-server.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

---

## Step 2 — Deploy on Railway

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `get-me-out-server` repo
4. Railway will auto-detect Node.js and deploy it
5. Once deployed, click your service → **Settings** → **Networking** → **Generate Domain**
6. Copy the domain — it looks like `get-me-out-server-production.up.railway.app`

---

## Step 3 — Update Godot

Open `autoloads/NetworkManager.gd` and change this line:

```gdscript
const SERVER_URL_HOSTED = "ws://localhost:8765"
```

To:

```gdscript
const SERVER_URL_HOSTED = "wss://your-domain.up.railway.app"
```

Note: use `wss://` (secure WebSocket) not `ws://` for Railway.

Then in UsernameSetup.gd, change the connect call to use the hosted server:

```gdscript
NetworkManager.connect_to_server(true)  # pass true for hosted
```

Or keep `false` for local testing and `true` for production.

---

## Cost

Railway's free tier gives $5 of credit per month.
A small WebSocket server like this uses almost nothing — typically under $0.50/month.
You'll get a warning email long before you'd be charged anything.

---

## Keeping accounts safe

Player passwords are hashed with bcrypt before being saved.
Even if someone got access to `data/accounts.json`, they couldn't read passwords.
Session tokens let players stay logged in without re-entering passwords.
