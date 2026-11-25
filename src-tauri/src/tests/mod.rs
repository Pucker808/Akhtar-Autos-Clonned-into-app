//! SQLite schema, transaction, import, backup/restore, and IPC contract tests.
//! Every test works inside its own temporary directory.

mod database;
mod ipc;
mod support;
mod transactions;
