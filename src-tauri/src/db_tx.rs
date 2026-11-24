//! Transactional writes, bulk import, and backup/restore for Akhtar Autos Desktop.
//!
//! Safety:
//! - Never creates a missing database file (open_readwrite refuses).
//! - Import refuses non-empty DBs unless confirm_overwrite is true (after safety backup).
//! - Restore always safety-renames the current DB file when it exists.
//! - Accounting (FIFO, balances) remains in TypeScript; this module applies
//!   pre-validated row mutations atomically.

include!("db_tx_part1.inc.rs");
include!("db_tx_part2.inc.rs");
include!("db_tx_part3.inc.rs");
