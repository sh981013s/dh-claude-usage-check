# Homebrew Cask

This folder contains helper assets for publishing a Homebrew cask.

## Generate cask file
From the repo root:

```bash
./scripts/make-cask.sh <owner> <repo> <version> <sha256>
```

It writes:

`packaging/homebrew/Casks/dh-claude-proxy-monitor.rb`

## Publish flow
1. Create/own a Homebrew tap repo (e.g. `homebrew-tools`).
2. Copy the generated cask file into `Casks/` in that tap.
3. Commit and push.
4. Users install with:
   - `brew tap <owner>/tools`
   - `brew install --cask dh-claude-proxy-monitor`
