# Windows in-app updates

Installed apps read `latest.json` from the newest GitHub Release, show
"Nayi update available hai", back up the data, then install the signed update.

## One-time setup

Add the private signing key as the repository secret `TAURI_SIGNING_PRIVATE_KEY`
(GitHub: Settings, Secrets and variables, Actions). The public key is in
`src-tauri/tauri.conf.json`. The key has no password.

Keep a private copy of the key. If it is lost, installed apps cannot accept new
updates and must be reinstalled by hand with a build that has a new public key.
Never commit it.

## Publishing a release

1. Raise the version in `src-tauri/tauri.conf.json`, `package.json` and
   `src-tauri/Cargo.toml` (and refresh `Cargo.lock`), then merge to `main`.
2. Run the "Release (Windows update)" workflow on `main`.
   It publishes only after every verification job passes.

The repository must stay public: installed apps download releases without a login.

## Data safety

Before installing, every table is written to
`%APPDATA%\com.akhtar.autos.desktop\pre-update-backups\`. If that fails, the
update does not run. In the uninstaller, never tick "delete application data".

Pushing code alone changes nothing on the user's PC. Android is not covered.

## Restoring a backup

Settings, "Local backup", "Restore from file" loads a downloaded backup or one of
the automatic files above. On Windows the current records are first saved to
`pre-restore-backups` in the same app data folder.
