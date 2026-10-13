//! Núcleo do Vapor: manifestos, catálogo, blocklist e saves.
//! Sem dependência de Tauri, para ser testável e reutilizável pela CLI.

pub mod blocklist;
pub mod catalog;
pub mod manifest;
pub mod saves;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("manifesto inválido ({path}): {reason}")]
    InvalidManifest { path: String, reason: String },
    #[error("jogo bloqueado pela blocklist: {0}")]
    Blocked(String),
    #[error("save inválido: {0}")]
    InvalidSave(String),
}

pub type Result<T> = std::result::Result<T, Error>;
