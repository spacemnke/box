# SM // Question Box

A private question box for Space Monkey. Visitors drop questions (with optional image attachments). You log into the admin panel to read and reply. CRT terminal aesthetic, IBM Plex Mono, signal colors.

Built with React + Vite + Firebase Firestore.

## Stack

- **Frontend:** React 18, Vite
- **Database:** Firebase Firestore (free tier handles thousands of questions)
- **Hosting:** GitHub Pages (free, auto-deploys on push to `main`)
- **Storage:** Images embedded as compressed base64 in Firestore docs (no separate Storage bucket needed)

## Local development

```bash
npm install
cp .env.example .env
# fill in your Firebase config in .env
npm run dev
```

## One-time setup

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** → name it (e.g. `sm-questionbox`)
2. Skip Google Analytics
3. In the project, click the web icon (`</>`) → register an app called `sm-questionbox-web`
4. Copy the `firebaseConfig` object — you'll need these 6 values

### 2. Enable Firestore

1. Left sidebar → **Build → Firestore Database** → **Create database**
2. Start in **production mode** (we'll add custom rules)
3. Pick a region close to you (e.g. `us-east4` or `us-west1`)
4. Once created, go to the **Rules** tab and paste the contents of `firestore.rules` from this repo. Click **Publish**.

### 3. GitHub repo

This app lives in [`spacemnke/box`](https://github.com/spacemnke/box). The GitHub Action deploys whatever is on `main`.

### 4. Add secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**

Add each of these (values from step 1):

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_ADMIN_PASSWORD` ← pick whatever password you want for the inbox

### 5. Enable GitHub Pages

Repo → **Settings → Pages → Source: GitHub Actions**

### 6. Push

Once the secrets are set, merge this branch into `main` (or push directly to `main`). The Action runs, builds with your secrets, and deploys to Pages. After ~1 minute your site is live at:

```
https://spacemnke.github.io/box/
```

That URL is what you share.

## Sharing

- **Public link** (give to your audience): `https://spacemnke.github.io/box/`
- **Admin access**: same URL — click `[ADMIN]` in the top right, enter your password

## Custom domain (optional)

If you want `questions.spacemnke.com` instead of the github.io URL:

1. Add a `CNAME` file at the root of this repo containing your domain
2. Settings → Pages → Custom domain → enter the domain
3. Add a CNAME DNS record at your registrar pointing to `<you>.github.io`

## Updating

Just edit and push. The Action redeploys automatically.

```bash
git add .
git commit -m "tweak copy"
git push
```

## Notes & limits

- **Firestore free tier:** 50K reads, 20K writes, 20K deletes per day, 1GB storage. You will not hit this.
- **Images:** Auto-resized to max 1600px and JPEG-compressed at 82% quality client-side before upload. Each Firestore doc is capped at 1MB total, so the form limits to 4 images at 1.5MB each pre-compression.
- **Admin password is client-side.** Anyone who reads the bundled JS can find it. This is fine for a casual question box. If you want real security, enable Firebase Auth and gate the admin reads to a specific email.
- **Rate limiting:** None built in. If you get spam, the easiest fix is adding hCaptcha or Cloudflare Turnstile to the public form, or tightening the Firestore rules to require Firebase Auth anonymous tokens.

## File map

```
box/
├── .github/workflows/deploy.yml   # GitHub Action: build + deploy on push
├── src/
│   ├── App.jsx                    # Main UI
│   ├── firebase.js                # Firestore wrapper
│   ├── main.jsx                   # React entry
│   └── index.css                  # Global styles + keyframes
├── firestore.rules                # Paste into Firebase Console → Rules
├── index.html                     # Vite entry
├── vite.config.js
├── package.json
└── .env.example                   # Template for local .env
```

---

v1.0 · SIGNAL_OVER_NOISE
