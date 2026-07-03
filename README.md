# RustShell

RustShell is a Tauri 2 desktop SSH/Shell client with a Rust backend and React
workspace. It provides tabbed terminals, SSH host-key trust, session storage,
SFTP file management, transfer tracking, settings persistence, and local shell
support.

## Stack

- Rust + Tauri commands for session, terminal, settings, SSH, SFTP, and storage.
- `ssh2` for SSH shell and SFTP, with app-managed `known_hosts`.
- `portable-pty` for local shell sessions.
- React + xterm.js for the desktop workspace.
- System keyring for remembered passwords.

## Implemented

- Session tree with search, recent-connect ordering, quick connect, session editor with explicit connection password/passphrase input, duplicate/delete, reconnect, import/export, and local shell tabs.
- Persistent terminal tabs with output drain, history replay, and per-session charset encoding/streaming decode for terminal input/output.
- SSH host-key confirmation, trust persistence, known_hosts management, password plus keyboard-interactive authentication, Agent password fallback, and credential prompts after terminal/SFTP browse/file-management/search/edit/stats/checksum auth failures.
- Settings dialog for theme, font size, scrollback, copy behavior, configured local shell command, and exit confirmation.
- Local and remote file panels with committed path navigation, visible/selected item stats plus on-demand recursive selected-size calculation with per-item failure summary, select-all/invert/clear selection controls, name/path/link-target search, explicit SFTP reconnect, automatic cached-SFTP invalidation after connection/auth changes, local/remote terminal-open-here with configured local shell support and SSH auto-connect, symlink target display/location/copy, safe non-overwriting relative file/folder/symlink creation with created-item parent reveal, rename, previewed batch rename with numbered `{n}` tokens and extension preservation, and move, symlink- and metadata-preserving local duplicate, metadata-preserving remote duplicate, batch duplicate/move/delete/chmod/properties metadata updates with per-item failure summary and octal/symbolic permission input, copyable properties metadata reports plus copy/download CSV/JSON export, deletion confirmation with copy/download CSV/JSON target audit, full/parent/relative path copy, TSV/CSV file-info copy plus selected-item and current-directory CSV export, path/SFTP URI/port- and key-aware scp/rsync/rsync-dry-run/chmod/chown/touch/ln/stat/sha256sum/du/ls/rm command copy, owner/group, numeric/symbolic permission, and minute-precision timestamp columns, remove, upload/download, local/remote symlink-safe permissions, ownership, timestamps, regular-file SHA-256 checksums, metadata-preserving regular-file text editing, and large-file read-only head/tail previews.
- Directory compare and sync with all/difference/same/one-sided/different view filters, visible difference reasons for type, size, timestamp, permissions, owner/group, and symlink targets, full CSV/JSON plus difference-only CSV compare report copy/export, quick selection of one-sided and paired differing items, sync-plan preview with copy/download CSV and JSON audit, JSON plan import/replay, per-item target-path execution before queued transfers or metadata-only changes, missing-only transfer shortcuts, plus metadata-only sync for matching differences with per-item failure summary.
- Local/remote selected regular-file SHA-256 verification and batch checksum-list copy plus copy/download CSV/JSON audit export with per-item failure summary for post-transfer checks.
- Transfer queue with progress snapshots, retry attempt tracking, resume/overwrite/skip/rename conflict handling, metadata preservation, symlink-preserving uploads/downloads, batch enqueue with per-item failure summary, persisted recent transfer history, single-task detail copy, CSV/JSON audit copy/export across queue and history, result locating with completed-item selection, cancellation, batch cancel, retry, per-item removal, clear-finished, and clear-history controls.
- Experimental Slint native preview reusing the Rust core for session browsing, local/remote file operations, delete previews, octal/symbolic chmod, transfers with persisted history plus CSV/JSON audit preview, context-aware remote path command previews, local/remote text head/tail previews, and local/remote CSV directory-list previews.
- Toast notifications, status bar, daily file logging, CSP hardening, and Tauri command API wrappers.

## Development

```powershell
npm install
npm run dev
cargo run
```

Per project instruction, recent changes were delivered without compile/build/test
verification.
