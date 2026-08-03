import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Advisory exclusive write lease for persistent sessions (pi-remote ADR-6).
 *
 * A session JSONL file must have exactly one Pi writer. Pi 0.83 has no
 * ownership lock, so two processes opening the same session can retain
 * divergent in-memory trees and corrupt logical ownership. This module
 * provides an atomic lock-directory lease keyed by
 * `(canonical session directory, exact session ID)` — not by file path, so a
 * blank session is locked before its JSONL file exists.
 *
 * Lock artifacts live in a dedicated private namespace:
 *
 *   <agentDir>/session-locks/<sha256(sessionDir + NUL + sessionId)>/lease.json
 *
 * Acquisition is an atomic mkdir. Stale reclamation never uses mtime age: a
 * lock is reclaimed only when the holder is verifiably gone (different boot
 * ID, dead PID, or PID reuse proven by a process-start fingerprint mismatch).
 * Ambiguous states (unreadable metadata, unverifiable process) fail closed
 * and report a conflict.
 */

export const SESSION_LEASE_FORMAT_VERSION = 1;

/** Metadata persisted inside the lock directory. */
export interface SessionLeaseMetadata {
	formatVersion: number;
	sessionDir: string;
	sessionId: string;
	sessionFile?: string;
	hostname: string;
	bootId: string | null;
	pid: number;
	/** `ps -o lstart=` fingerprint of the holder process (PID-reuse guard). */
	processStart: string | null;
	acquiredAt: string;
	/** Random ownership token; release only removes the lock we still own. */
	token: string;
	/** Optional pi-remote orchestration identity. */
	launchId?: string;
	runtimeId?: string;
}

export interface SessionLeaseOwner {
	pid: number;
	hostname: string;
	acquiredAt: string;
	sessionId: string;
	sessionDir: string;
	sessionFile?: string;
	launchId?: string;
	runtimeId?: string;
}

/** Thrown when another live process holds the session write lease. */
export class SessionLeaseConflictError extends Error {
	readonly owner: SessionLeaseOwner;

	constructor(owner: SessionLeaseOwner) {
		super(
			`Session '${owner.sessionId}' is already open in another Pi process ` +
				`(pid ${owner.pid} on ${owner.hostname}, since ${owner.acquiredAt}). ` +
				`Close that process first. If it crashed, the lease is reclaimed automatically.`,
		);
		this.name = "SessionLeaseConflictError";
		this.owner = owner;
	}
}

export interface SessionLease {
	readonly key: string;
	readonly lockDir: string;
	readonly metadata: SessionLeaseMetadata;
	/** Idempotent. Only removes the lock directory while we still own it. */
	release(): void;
}

export type LeaseHolderStatus = "alive" | "dead" | "unknown";

// ---------------------------------------------------------------------------
// Platform helpers (cached: these never change for the life of the process)
// ---------------------------------------------------------------------------

let cachedBootId: string | null | undefined;

/** Kernel boot identity. A mismatch proves the lock predates a reboot. */
export function getBootId(): string | null {
	if (cachedBootId !== undefined) return cachedBootId;
	let bootId: string | null = null;
	try {
		if (platform() === "darwin") {
			const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 3000 });
			// "{ sec = 1754220000, usec = 0 } Mon Aug  3 ..."
			const match = /sec\s*=\s*(\d+)/.exec(out);
			bootId = match?.[1] ?? out.trim();
		} else if (platform() === "linux") {
			bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		}
	} catch {
		bootId = null;
	}
	cachedBootId = bootId;
	return bootId;
}

/** `ps` start-time fingerprint for a PID; null when unavailable. */
export function getProcessStartFingerprint(pid: number): string | null {
	try {
		const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			timeout: 3000,
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

let cachedSelfFingerprint: string | null | undefined;

function getSelfFingerprint(): string | null {
	if (cachedSelfFingerprint === undefined) {
		cachedSelfFingerprint = getProcessStartFingerprint(process.pid);
	}
	return cachedSelfFingerprint;
}

/**
 * Verify whether the recorded holder still exists. Same-host recovery must
 * prove the exact process instance is gone, never infer from lock age.
 */
export function leaseHolderStatus(meta: SessionLeaseMetadata): LeaseHolderStatus {
	const bootId = getBootId();
	if (meta.bootId && bootId && meta.bootId !== bootId) return "dead";
	let pidExists = false;
	try {
		process.kill(meta.pid, 0);
		pidExists = true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		// EPERM or anything else: cannot verify → fail closed.
		return "unknown";
	}
	if (!pidExists) return "dead";
	// PID is alive; guard against PID reuse with the start-time fingerprint.
	const current = getProcessStartFingerprint(meta.pid);
	if (current && meta.processStart && current !== meta.processStart) return "dead";
	if (!current || !meta.processStart) return "unknown";
	return "alive";
}

// ---------------------------------------------------------------------------
// Key/path helpers
// ---------------------------------------------------------------------------

/** Canonicalize a session directory for the lease key (symlinks resolved). */
export function canonicalizeSessionDir(sessionDir: string): string {
	const abs = resolve(sessionDir);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

export function sessionLeaseKey(sessionDir: string, sessionId: string): string {
	return createHash("sha256").update(`${sessionDir}${sessionId}`).digest("hex");
}

export function sessionLocksBaseDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "session-locks");
}

export function sessionLeaseLockDir(sessionDir: string, sessionId: string, agentDir?: string): string {
	return join(sessionLocksBaseDir(agentDir), sessionLeaseKey(sessionDir, sessionId));
}

// ---------------------------------------------------------------------------
// Metadata I/O
// ---------------------------------------------------------------------------

function metadataPath(lockDir: string): string {
	return join(lockDir, "lease.json");
}

export function readLeaseMetadata(lockDir: string): SessionLeaseMetadata | null {
	try {
		const raw = JSON.parse(readFileSync(metadataPath(lockDir), "utf8")) as Partial<SessionLeaseMetadata>;
		if (raw.formatVersion !== SESSION_LEASE_FORMAT_VERSION) return null;
		if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string" || typeof raw.sessionDir !== "string") {
			return null;
		}
		return raw as SessionLeaseMetadata;
	} catch {
		return null;
	}
}

function toOwner(meta: SessionLeaseMetadata): SessionLeaseOwner {
	return {
		pid: meta.pid,
		hostname: meta.hostname,
		acquiredAt: meta.acquiredAt,
		sessionId: meta.sessionId,
		sessionDir: meta.sessionDir,
		sessionFile: meta.sessionFile,
		launchId: meta.launchId,
		runtimeId: meta.runtimeId,
	};
}

// ---------------------------------------------------------------------------
// Re-entrant per-process registry
// ---------------------------------------------------------------------------

/**
 * Leases protect against *other* processes. Within one process, several
 * SessionManager instances may legitimately hold the same session (e.g. fork
 * opens the current file in a second manager before switching away), so
 * acquisitions are reference-counted per key.
 */
const heldLeases = new Map<string, { meta: SessionLeaseMetadata; lockDir: string; refcount: number }>();
let exitHookInstalled = false;

function releaseAllAtExit(): void {
	for (const [key, entry] of heldLeases) {
		removeLockDirIfOwned(entry.lockDir, entry.meta.token);
		heldLeases.delete(key);
	}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", releaseAllAtExit);
}

function removeLockDirIfOwned(lockDir: string, token: string): void {
	try {
		const meta = readLeaseMetadata(lockDir);
		if (meta && meta.token !== token) return; // reacquired by someone else
		rmSync(lockDir, { recursive: true, force: true });
	} catch {
		// best effort; a stale remnant is recovered by the next acquirer
	}
}

/**
 * A lock directory without readable metadata is an incomplete acquisition
 * (crash between mkdir and metadata write). It is reclaimed only after a
 * short grace window; this is not age-based staleness of a valid lease.
 */
const INCOMPLETE_ACQUIRE_GRACE_MS = 30_000;

function tryReclaimIncompleteLock(lockDir: string): boolean {
	try {
		const age = Date.now() - statSync(lockDir).mtimeMs;
		if (age < INCOMPLETE_ACQUIRE_GRACE_MS) return false;
		rmSync(lockDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

export interface AcquireSessionLeaseOptions {
	/** Canonical (or absolute) session directory the JSONL lives/will live in. */
	sessionDir: string;
	sessionId: string;
	sessionFile?: string;
	agentDir?: string;
}

/**
 * Acquire the exclusive write lease for a session. Re-entrant within the
 * process. Throws SessionLeaseConflictError when another live process holds
 * the lease; reclaims locks whose holder is verifiably gone.
 */
export function acquireSessionLease(options: AcquireSessionLeaseOptions): SessionLease {
	const sessionDir = canonicalizeSessionDir(options.sessionDir);
	const key = sessionLeaseKey(sessionDir, options.sessionId);

	const held = heldLeases.get(key);
	if (held) {
		held.refcount++;
		let released = false;
		return {
			key,
			lockDir: held.lockDir,
			metadata: held.meta,
			release: () => {
				if (released) return;
				released = true;
				decrementLease(key);
			},
		};
	}

	const agentDir = options.agentDir ?? getAgentDir();
	const locksBase = sessionLocksBaseDir(agentDir);
	const lockDir = join(locksBase, key);

	mkdirSync(locksBase, { recursive: true, mode: 0o700 });

	const meta: SessionLeaseMetadata = {
		formatVersion: SESSION_LEASE_FORMAT_VERSION,
		sessionDir,
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		hostname: hostname(),
		bootId: getBootId(),
		pid: process.pid,
		processStart: getSelfFingerprint(),
		acquiredAt: new Date().toISOString(),
		token: randomBytes(16).toString("hex"),
		launchId: process.env.PI_REMOTE_LAUNCH_ID || undefined,
		runtimeId: process.env.PI_REMOTE_RUNTIME_ID || undefined,
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			// Acquired. Persist metadata; the token protects release(). If the
			// write fails, undo the mkdir so no incomplete lock is left behind.
			try {
				writeFileSync(metadataPath(lockDir), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
			} catch (writeErr) {
				rmSync(lockDir, { recursive: true, force: true });
				throw writeErr;
			}
			heldLeases.set(key, { meta, lockDir, refcount: 1 });
			installExitHook();
			let released = false;
			return {
				key,
				lockDir,
				metadata: meta,
				release: () => {
					if (released) return;
					released = true;
					decrementLease(key);
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const existing = readLeaseMetadata(lockDir);
			if (!existing) {
				if (existsSync(lockDir) && tryReclaimIncompleteLock(lockDir)) continue;
				// Unknown owner, possibly still starting: fail closed.
				throw new SessionLeaseConflictError({
					pid: 0,
					hostname: "unknown",
					acquiredAt: "unknown",
					sessionId: options.sessionId,
					sessionDir,
				});
			}
			if (existing.pid === process.pid && existing.processStart === getSelfFingerprint()) {
				// Our own lock from a path that bypassed the registry (should not
				// happen, but never deadlock against ourselves).
				heldLeases.set(key, { meta: existing, lockDir, refcount: 1 });
				installExitHook();
				let released = false;
				return {
					key,
					lockDir,
					metadata: existing,
					release: () => {
						if (released) return;
						released = true;
						decrementLease(key);
					},
				};
			}
			const status = leaseHolderStatus(existing);
			if (status === "alive" || status === "unknown") {
				throw new SessionLeaseConflictError(toOwner(existing));
			}
			// Verifiably stale: reclaim and retry the atomic mkdir once.
			removeLockDirIfOwned(lockDir, existing.token);
			if (existsSync(lockDir)) {
				// Could not remove (token mismatch or race): treat as conflict.
				throw new SessionLeaseConflictError(toOwner(existing));
			}
		}
	}
	throw new SessionLeaseConflictError({
		pid: 0,
		hostname: "unknown",
		acquiredAt: "unknown",
		sessionId: options.sessionId,
		sessionDir,
	});
}

function decrementLease(key: string): void {
	const held = heldLeases.get(key);
	if (!held) return;
	held.refcount--;
	if (held.refcount > 0) return;
	heldLeases.delete(key);
	removeLockDirIfOwned(held.lockDir, held.meta.token);
}

// ---------------------------------------------------------------------------
// Dashboard/diagnostic inspection (no acquisition, no mutation)
// ---------------------------------------------------------------------------

export interface SessionLeaseInspection {
	/** "free" | "held" | "stale" (holder verifiably gone; next open reclaims). */
	status: "free" | "held" | "stale";
	owner?: SessionLeaseOwner;
}

export function inspectSessionLease(sessionDir: string, sessionId: string, agentDir?: string): SessionLeaseInspection {
	const canonical = canonicalizeSessionDir(sessionDir);
	const lockDir = sessionLeaseLockDir(canonical, sessionId, agentDir);
	if (!existsSync(lockDir)) return { status: "free" };
	const meta = readLeaseMetadata(lockDir);
	if (!meta) return { status: "held" }; // unknown owner: fail closed
	const status = leaseHolderStatus(meta);
	if (status === "alive") return { status: "held", owner: toOwner(meta) };
	if (status === "unknown") return { status: "held", owner: toOwner(meta) };
	return { status: "stale", owner: toOwner(meta) };
}
