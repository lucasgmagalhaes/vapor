//! Vapor core: manifests, catalog, blocklist and saves.
//! No Tauri dependency, so it is testable and reusable by the CLI.

pub mod blocklist;
pub mod catalog;
pub mod manifest;
pub mod saves;
pub mod unpack;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("invalid manifest ({path}): {reason}")]
    InvalidManifest { path: String, reason: String },
    #[error("game blocked by blocklist: {0}")]
    Blocked(String),
    #[error("invalid archive: {0}")]
    InvalidArchive(String),
    #[error("invalid save: {0}")]
    InvalidSave(String),
}

pub type Result<T> = std::result::Result<T, Error>;
