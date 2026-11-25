# Akhtar Autos Desktop

Standalone Windows desktop application for **Akhtar Autos** — inventory, POS, purchases, customers, suppliers, expenses and reports for an automobile spare-parts shop.

This repository is **independent** of the original web application:

| | Web (original) | Desktop (this repo) |
|---|---|---|
| Repository | [akhtar-autoparts-manager](https://github.com/Pucker808/akhtar-autoparts-manager) | [Akhtar-Autos-Clonned-into-app](https://github.com/Pucker808/Akhtar-Autos-Clonned-into-app) |
| Runtime | Browser / PWA (Vercel) | Tauri 2 native window |
| Primary storage | IndexedDB (Dexie) | IndexedDB (Dexie) today; SQLite planned |
| Target | Web | Windows 10/11 first; Android later |

The original web app remains untouched and operational.

## Architecture

- **Frontend:** React 19 + TypeScript (adapted from the web app)
- **Desktop shell:** Tauri 2
- **Native backend:** Rust
- **Database:** SQLite with user-configurable primary data folder
- **Backups:** Local automatic + manual; optional Google Drive later
- **Offline-first:** All core shop workflows work without internet

### Hybrid storage (design)

Default primary database location (Windows):

```
%LOCALAPPDATA%\AkhtarAutos\Database\akhtar-autos.db
```

Users can choose a custom folder for the database and a separate folder for backups. The app must never silently create an empty database when an existing one is missing or inaccessible — recovery UI is required.

## Development

### Prerequisites (Windows)

- Bun 1.4.4 (the only supported package manager; `bun.lock` is committed)
- Node.js 22+
- Rust stable (https://rustup.rs); `src-tauri/Cargo.lock` is committed
- Microsoft C++ Build Tools / Visual Studio Build Tools
- WebView2 (usually preinstalled on Windows 10/11)

### Commands

```bash
bun install --frozen-lockfile
bun run typecheck           # strict TypeScript
bun run test                # Vitest
bun run build               # static frontend in dist/client (run before cargo)
cargo test --manifest-path src-tauri/Cargo.toml --locked
bun run desktop:dev         # Tauri + frontend
bun run desktop:build       # installers under src-tauri/target/release/bundle/
```

## Phase status

- [x] Phase 1 foundation: separate repo, frontend seed, Tauri 2 scaffold, SQLite/storage design
- [ ] Phase 2: SQLite foundation (awaiting independent review, see docs/PHASE2.md)
- [ ] Phase 3: SQLite business operations (not started)
- [ ] Phase 4–5: hybrid folder config, backup/restore, recovery UI
- [ ] Phase 6–9: feature verification, installer, release
- [ ] Phase 10: Android (after Windows is solid)

## License / ownership

Shop software for the owner of Akhtar Autos. Do not commit real shop data, secrets, or OAuth client secrets.
