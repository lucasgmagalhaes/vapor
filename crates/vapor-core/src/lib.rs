//! Vapor core: manifests, catalog, blocklist and saves.
//! No Tauri dependency, so it is testable and reusable by the CLI.

pub mod blocklist;
pub mod audit;
pub mod bridge;
pub mod byo;
pub mod catalog;
pub mod manifest;
pub mod saves;
pub mod serve;
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
    #[error("invalid bring-your-own file: {0}")]
    InvalidByo(String),
    #[error("invalid save: {0}")]
    InvalidSave(String),
}

pub type Result<T> = std::result::Result<T, Error>;
