//! Shared cache of live SFTP connections, keyed by session profile.
//!
//! Two invariants drive the design:
//!
//! 1. **The map lock is never held across network I/O.** Callers take the map
//!    lock only long enough to clone out an `Arc<Mutex<SftpSlot>>`, then release
//!    it. A ten-second directory listing on one host therefore cannot stall
//!    browsing on another host, nor any unrelated code that needs the map.
//! 2. **One profile is served by one connection at a time.** libssh2 sessions
//!    are not thread-safe, so serializing per profile is a correctness
//!    requirement, not just a fairness one. The per-slot mutex provides it.
//!
//! Connecting happens *inside* the slot lock so that concurrent callers for the
//! same profile queue up behind a single handshake instead of racing to open
//! several.

use crate::{core::session::SessionProfile, services::sftp_service::SftpConnection};
use anyhow::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use uuid::Uuid;

const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_SESSIONS: usize = 4;

/// libssh2 codes that describe a *remote* refusal rather than a broken
/// transport. Reconnecting after one of these would be pure waste: the session
/// is healthy, the server simply said no.
const SFTP_PROTOCOL_ERROR: i32 = -31;
const FILE_ERROR: i32 = -16;

/// Separates "could not reach or authenticate to the host" from "the host
/// answered and refused". Only the former says anything about whether an
/// OpenSSH fallback is worth remembering for this profile.
#[derive(Debug)]
pub enum SftpFailure {
    Connect(String),
    Operation(String),
}

impl SftpFailure {
    pub fn is_connect(&self) -> bool {
        matches!(self, Self::Connect(_))
    }
}

impl std::fmt::Display for SftpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(message) | Self::Operation(message) => f.write_str(message),
        }
    }
}

struct SftpSlot {
    connection: Option<SftpConnection>,
    last_used: Instant,
}

impl SftpSlot {
    fn new() -> Self {
        Self {
            connection: None,
            last_used: Instant::now(),
        }
    }
}

#[derive(Default)]
pub struct SftpPool {
    slots: Mutex<HashMap<Uuid, Arc<Mutex<SftpSlot>>>>,
}

impl SftpPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `action` against a live connection for `profile`, connecting first if
    /// needed. A dead session is transparently replaced and the action retried
    /// once.
    pub fn with<T, F>(
        &self,
        profile: &SessionProfile,
        password: Option<&str>,
        action: F,
    ) -> Result<T, String>
    where
        F: FnMut(&mut SftpConnection) -> Result<T>,
    {
        self.with_detail(profile, password, action)
            .map_err(|failure| failure.to_string())
    }

    /// As [`SftpPool::with`], but reports whether the failure was in
    /// establishing the session or in the operation itself.
    pub fn with_detail<T, F>(
        &self,
        profile: &SessionProfile,
        password: Option<&str>,
        mut action: F,
    ) -> Result<T, SftpFailure>
    where
        F: FnMut(&mut SftpConnection) -> Result<T>,
    {
        let slot = self.slot_for(profile.id);
        let mut slot = lock_slot(&slot);
        slot.last_used = Instant::now();

        // Taking the connection out by value keeps the borrow of `slot` and the
        // borrow of the connection from ever overlapping.
        if let Some(mut connection) = slot.connection.take() {
            match action(&mut connection) {
                Ok(value) => {
                    slot.connection = Some(connection);
                    return Ok(value);
                }
                // A server-side "no" (missing file, denied permission) says
                // nothing about the transport, so keep the session and surface
                // the error as-is.
                Err(error) if !is_transport_error(&error) => {
                    slot.connection = Some(connection);
                    return Err(SftpFailure::Operation(error.to_string()));
                }
                // Transport failure: drop the dead session and reconnect below.
                Err(_) => {}
            }
        }

        let mut connection = SftpConnection::connect(profile, password)
            .map_err(|error| SftpFailure::Connect(error.to_string()))?;
        let outcome = action(&mut connection);
        slot.last_used = Instant::now();
        match outcome {
            Ok(value) => {
                slot.connection = Some(connection);
                Ok(value)
            }
            Err(error) => {
                if !is_transport_error(&error) {
                    slot.connection = Some(connection);
                }
                Err(SftpFailure::Operation(error.to_string()))
            }
        }
    }

    /// Run a command on the pooled SSH session and return its stdout.
    ///
    /// Reusing the session avoids the TCP connect, key exchange and auth that
    /// dominate the cost of a one-shot remote command.
    pub fn exec_detail(
        &self,
        profile: &SessionProfile,
        password: Option<&str>,
        command: &str,
    ) -> Result<String, SftpFailure> {
        self.with_detail(profile, password, |connection| connection.exec(command))
    }

    pub fn invalidate(&self, profile_id: Uuid) {
        lock_map(&self.slots).remove(&profile_id);
    }

    pub fn retain_profiles(&self, keep: &[Uuid]) {
        lock_map(&self.slots).retain(|id, _| keep.contains(id));
    }

    /// Clone out (or create) the slot for `profile_id`, holding the map lock for
    /// the shortest possible time.
    fn slot_for(&self, profile_id: Uuid) -> Arc<Mutex<SftpSlot>> {
        let mut slots = lock_map(&self.slots);
        prune(&mut slots, profile_id);
        slots
            .entry(profile_id)
            .or_insert_with(|| Arc::new(Mutex::new(SftpSlot::new())))
            .clone()
    }
}

/// Drop idle slots, then oldest-first until we are back under the cap. A slot
/// whose `try_lock` fails is busy on another thread, so it is left alone.
fn prune(slots: &mut HashMap<Uuid, Arc<Mutex<SftpSlot>>>, keep: Uuid) {
    let now = Instant::now();
    slots.retain(|id, slot| {
        if *id == keep {
            return true;
        }
        match slot.try_lock() {
            Ok(slot) => now.duration_since(slot.last_used) <= IDLE_TIMEOUT,
            Err(_) => true,
        }
    });

    if slots.len() <= MAX_SESSIONS {
        return;
    }

    let overflow = slots.len().saturating_sub(MAX_SESSIONS);
    let mut candidates: Vec<(Uuid, Instant)> = slots
        .iter()
        .filter(|(id, _)| **id != keep)
        .filter_map(|(id, slot)| slot.try_lock().ok().map(|slot| (*id, slot.last_used)))
        .collect();
    candidates.sort_by_key(|(_, last_used)| *last_used);

    for (id, _) in candidates.into_iter().take(overflow) {
        slots.remove(&id);
    }
}

/// True when the failure looks like a broken transport, i.e. reconnecting could
/// plausibly help.
fn is_transport_error(error: &anyhow::Error) -> bool {
    let Some(ssh_error) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ssh2::Error>())
    else {
        // No libssh2 error in the chain means this came from local I/O or our
        // own validation, so the connection itself is fine.
        return false;
    };

    match ssh_error.code() {
        ssh2::ErrorCode::Session(code) => code != SFTP_PROTOCOL_ERROR && code != FILE_ERROR,
        _ => false,
    }
}

fn lock_map<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_slot(slot: &Arc<Mutex<SftpSlot>>) -> MutexGuard<'_, SftpSlot> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
