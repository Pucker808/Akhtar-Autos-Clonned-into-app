//! Hybrid storage path resolution.
//!
//! Default layout (Windows):
//!   %LOCALAPPDATA%\\AkhtarAutos\\
//!     Database\\akhtar-autos.db
//!     Attachments\\
//!     Backups\\Automatic\\
//!     Backups\\Manual\\
//!     Exports\\
//!     Settings\\app-settings.json
//!
//! Database location and backup location are independently configurable.
//! Never invent a new empty database when the configured path is missing.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("could not resolve app data directory")]
    NoAppData,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Default data root: LocalAppData/AkhtarAutos on Windows, XDG data dir elsewhere.
pub fn default_data_root() -> Result<PathBuf, StorageError> {
    let base = dirs::data_local_dir().ok_or(StorageError::NoAppData)?;
    Ok(base.join("AkhtarAutos"))
}

pub fn default_database_path() -> Result<PathBuf, StorageError> {
    Ok(default_data_root()?.join("Database").join("akhtar-autos.db"))
}

pub fn default_backups_dir() -> Result<PathBuf, StorageError> {
    Ok(default_data_root()?.join("Backups"))
}

pub fn default_settings_path() -> Result<PathBuf, StorageError> {
    Ok(default_data_root()?.join("Settings").join("app-settings.json"))
}

/// Ensure the *directory tree* exists for a chosen data root.
/// Does **not** create a database file.
pub fn ensure_data_layout(root: &PathBuf) -> Result<(), StorageError> {
    for sub in [
        "Database",
        "Attachments/Product Images",
        "Attachments/Documents",
        "Backups/Automatic",
        "Backups/Manual",
        "Exports/Invoices",
        "Exports/Reports",
        "Settings",
    ] {
        std::fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}
