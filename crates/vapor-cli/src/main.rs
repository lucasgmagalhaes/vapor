//! `vapor validate` / `vapor index`: usados pela CI e por contribuidores.

use std::path::PathBuf;
use std::process::ExitCode;

use vapor_core::blocklist::Blocklist;
use vapor_core::catalog::Catalog;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let root = PathBuf::from(args.next().unwrap_or_else(|| ".".into()));
    let result = (|| -> vapor_core::Result<Catalog> {
        let block = Blocklist::load(&root.join("takedown/blocklist.json"))?;
        Catalog::build(&root.join("games"), &block)
    })();
    match (cmd.as_str(), result) {
        ("validate", Ok(c)) => {
            println!("ok: {} jogo(s) válido(s)", c.games.len());
            ExitCode::SUCCESS
        }
        ("index", Ok(c)) => {
            let out = root.join("catalog.json");
            std::fs::write(&out, serde_json::to_vec_pretty(&c).unwrap()).expect("escrever catalog.json");
            println!("gerado {} ({} jogos)", out.display(), c.games.len());
            ExitCode::SUCCESS
        }
        ("validate" | "index", Err(e)) => {
            eprintln!("erro: {e}");
            ExitCode::FAILURE
        }
        _ => {
            eprintln!("uso: vapor <validate|index> [raiz-do-repo]");
            ExitCode::from(2)
        }
    }
}
