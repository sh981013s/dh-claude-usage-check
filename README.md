# DeliveryHero Claude Proxy Monitor

macOS menu bar app (Electron) for monitoring Claude usage in DeliveryHero proxy/LiteLLM environments.

## Features
- Tray percentage in macOS menu bar
- Popup status panel with animated metrics
- Spend/budget tracking from proxy headers and self-service endpoints
- Budget reset countdown (`Xd Yh`)
- Daily usage bars for the last 4 days (local snapshot-based)
- Claude service health badge

## Local Run
```bash
npm install
npm run start
```

## Build Artifacts
```bash
npm run dist
```

Outputs to `dist/`:
- `DH Claude Proxy Monitor-<version>-arm64.dmg`
- `DH Claude Proxy Monitor-<version>-arm64.zip`

## GitHub Setup (Step 1)
1. Create a new GitHub repository.
2. Update placeholders in `package.json`:
   - `repository.url`
   - `homepage`
   - `bugs.url`
   - `build.publish[0].owner`
3. Push code:
```bash
git add .
git commit -m "Initial release setup"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

## GitHub Releases (Step 2)
Tag-based release:
```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow (`.github/workflows/release.yml`) will:
- build macOS artifacts
- upload build artifacts
- create/update GitHub Release for tags like `v*`

## Easy Install Options (Step 3)
### Option A: Download `.dmg` from GitHub Releases
- Recommended for most users.

### Option B: Homebrew Cask
- Use the helper script in this repo (see below) to generate a cask file from a release asset.

## Code Signing + Notarization (Step 4)
Optional but recommended for smoother installation on macOS.

Add these GitHub Secrets:
- `CSC_LINK` (base64 p12 or file URL)
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

When secrets are present, `electron-builder` can sign/notarize automatically.

## Homebrew Cask (Step 5)
Generate cask snippet from released `.dmg`:
```bash
./scripts/make-cask.sh <owner> <repo> <version> <sha256>
```

Example:
```bash
./scripts/make-cask.sh your-org deliveryhero-claude-proxy-monitor 0.1.0 abcdef123...
```

It prints a ready-to-commit cask file under `packaging/homebrew/Casks/`.

## Debug: Inspect Usage Endpoints
1. Generate Claude debug log:
```bash
claude --print "ping" --debug api --debug-file /tmp/claude-debug.txt
```
2. Scan:
```bash
npm run scan:usage
```
