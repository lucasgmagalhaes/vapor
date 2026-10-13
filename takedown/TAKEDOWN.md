# Takedown policy

Vapor **does not host games**: the catalog only holds manifests that point to external URLs.

## How to request removal
Open an issue with the "Takedown" template, or write to the project contact, stating: the game (slug), the protected work, who the rights holder/representative is, and a good-faith statement.

## What we do
1. A maintainer opens a PR that deletes `games/<slug>/` and adds an entry (slug, sha256 and/or domain, date, reference) to `takedown/blocklist.json`.
2. CI rejects any future manifest that matches the blocklist.
3. When the catalog is refreshed, the app deletes from the player's disk the files of games that left the index. **The player's saves are preserved** (they are the player's data) and remain exportable.
4. The author may dispute via an issue; a human maintainer decides and records the outcome.

> Never commit binaries, ROMs or assets to this repository: CI rejects them.
