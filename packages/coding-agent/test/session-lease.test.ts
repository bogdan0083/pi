import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	acquireSessionLease,
	getProcessStartFingerprint,
	inspectSessionLease,
	readLeaseMetadata,
	SessionLeaseConflictError,
	type SessionLeaseMetadata,
	sessionLeaseLockDir,
} from "../src/core/session-lease.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix = "pi-lease-test-"): string {
	// realpath: macOS tmpdir() is a symlink; lease keys canonicalize.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

/** Agent dir + session dir pair with PI_CODING_AGENT_DIR pointed at the agent dir. */
function setupDirs(): { agentDir: string; sessionDir: string } {
	const root = createTempDir();
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	return { agentDir, sessionDir };
}

/** Write a foreign lease on disk (simulating another process). */
function plantForeignLease(
	agentDir: string,
	sessionDir: string,
	sessionId: string,
	overrides: Partial<SessionLeaseMetadata> = {},
): string {
	const lockDir = sessionLeaseLockDir(sessionDir, sessionId, agentDir);
	mkdirSync(lockDir, { recursive: true });
	const meta: SessionLeaseMetadata = {
		formatVersion: 1,
		sessionDir,
		sessionId,
		hostname: "foreign-host",
		bootId: null,
		pid: 1,
		processStart: null,
		acquiredAt: new Date().toISOString(),
		token: "foreign-token",
		...overrides,
	};
	writeFileSync(join(lockDir, "lease.json"), JSON.stringify(meta));
	return lockDir;
}

function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
	expect(child.pid).toBeDefined();
	return child.pid!;
}

const liveChildren: ReturnType<typeof spawn>[] = [];

afterEach(() => {
	for (const child of liveChildren.splice(0)) {
		child.kill("SIGKILL");
	}
});

/** A live process owned by this user, standing in for a foreign lease holder. */
function liveForeignProcess(): { pid: number; fingerprint: string } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	expect(child.pid).toBeDefined();
	liveChildren.push(child);
	const fingerprint = getProcessStartFingerprint(child.pid!);
	expect(fingerprint).toBeTruthy();
	return { pid: child.pid!, fingerprint: fingerprint! };
}

describe("session write lease", () => {
	it("acquires and releases the lock directory with metadata", () => {
		const { sessionDir } = setupDirs();
		const lease = acquireSessionLease({ sessionDir, sessionId: "s1" });
		expect(existsSync(lease.lockDir)).toBe(true);
		const meta = readLeaseMetadata(lease.lockDir);
		expect(meta?.sessionId).toBe("s1");
		expect(meta?.pid).toBe(process.pid);
		expect(meta?.formatVersion).toBe(1);
		lease.release();
		expect(existsSync(lease.lockDir)).toBe(false);
	});

	it("is re-entrant within one process (reference counted)", () => {
		const { sessionDir } = setupDirs();
		const a = acquireSessionLease({ sessionDir, sessionId: "s1" });
		const b = acquireSessionLease({ sessionDir, sessionId: "s1" });
		a.release();
		expect(existsSync(a.lockDir)).toBe(true);
		b.release();
		expect(existsSync(a.lockDir)).toBe(false);
	});

	it("rejects a second writer while a live foreign process holds the lease", () => {
		const { agentDir, sessionDir } = setupDirs();
		const foreign = liveForeignProcess();
		plantForeignLease(agentDir, sessionDir, "s1", {
			pid: foreign.pid,
			processStart: foreign.fingerprint,
			bootId: null,
		});
		expect(() => acquireSessionLease({ sessionDir, sessionId: "s1" })).toThrow(SessionLeaseConflictError);
		try {
			acquireSessionLease({ sessionDir, sessionId: "s1" });
		} catch (error) {
			const conflict = error as SessionLeaseConflictError;
			expect(conflict.owner.pid).toBe(foreign.pid);
			expect(conflict.message).toContain("already open in another Pi process");
		}
	});

	it("reclaims the lease of a verifiably dead process", () => {
		const { agentDir, sessionDir } = setupDirs();
		const pid = deadPid();
		plantForeignLease(agentDir, sessionDir, "s1", { pid, processStart: "whatever" });
		const lease = acquireSessionLease({ sessionDir, sessionId: "s1" });
		expect(existsSync(lease.lockDir)).toBe(true);
		lease.release();
	});

	it("reclaims on PID reuse (start fingerprint mismatch)", () => {
		const { agentDir, sessionDir } = setupDirs();
		const foreign = liveForeignProcess();
		plantForeignLease(agentDir, sessionDir, "s1", {
			pid: foreign.pid,
			processStart: "definitely-not-the-real-start-time",
			bootId: null,
		});
		const lease = acquireSessionLease({ sessionDir, sessionId: "s1" });
		lease.release();
	});

	it("reclaims on boot-id mismatch (lock predates a reboot)", () => {
		const { agentDir, sessionDir } = setupDirs();
		plantForeignLease(agentDir, sessionDir, "s1", {
			pid: process.pid, // even our own pid: a different boot proves staleness
			processStart: "x",
			bootId: "some-previous-boot",
		});
		const lease = acquireSessionLease({ sessionDir, sessionId: "s1" });
		lease.release();
	});

	it("fails closed on an incomplete lock (no metadata)", () => {
		const { agentDir, sessionDir } = setupDirs();
		const lockDir = sessionLeaseLockDir(sessionDir, "s1", agentDir);
		mkdirSync(lockDir, { recursive: true });
		expect(() => acquireSessionLease({ sessionDir, sessionId: "s1" })).toThrow(SessionLeaseConflictError);
		// An incomplete acquisition has no token to validate, so it requires
		// explicit cleanup rather than unsafe age-based reclamation.
		rmSync(lockDir, { recursive: true, force: true });
		const lease = acquireSessionLease({ sessionDir, sessionId: "s1" });
		lease.release();
	});

	it("fails closed when lock metadata does not match the requested key", () => {
		const { agentDir, sessionDir } = setupDirs();
		plantForeignLease(agentDir, sessionDir, "s1", { sessionId: "other-session" });
		expect(inspectSessionLease(sessionDir, "s1", agentDir)).toEqual({ status: "held" });
		expect(() => acquireSessionLease({ sessionDir, sessionId: "s1" })).toThrow(SessionLeaseConflictError);
	});

	it("inspection reports free / held / stale without mutating", () => {
		const { agentDir, sessionDir } = setupDirs();
		expect(inspectSessionLease(sessionDir, "s1", agentDir).status).toBe("free");

		const foreign = liveForeignProcess();
		plantForeignLease(agentDir, sessionDir, "s1", {
			pid: foreign.pid,
			processStart: foreign.fingerprint,
		});
		expect(inspectSessionLease(sessionDir, "s1", agentDir).status).toBe("held");

		const pid = deadPid();
		plantForeignLease(agentDir, sessionDir, "s2", { pid, processStart: "y" });
		const stale = inspectSessionLease(sessionDir, "s2", agentDir);
		expect(stale.status).toBe("stale");
		expect(stale.owner?.pid).toBe(pid);

		// Inspection never removes or creates lock dirs.
		expect(existsSync(sessionLeaseLockDir(sessionDir, "s2", agentDir))).toBe(true);
	});

	it("conflicts across real processes and reclaims after SIGKILL", async () => {
		const { agentDir, sessionDir } = setupDirs();
		const helper = resolve(__dirname, "fixtures/session-lease-holder.ts");
		const child = spawn(process.execPath, [helper, sessionDir, "cross-1"], {
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		try {
			await new Promise<void>((resolvePromise, reject) => {
				const timeout = setTimeout(() => reject(new Error("helper did not signal acquisition")), 15_000);
				child.stdout!.on("data", (chunk: Buffer) => {
					if (chunk.toString().includes("LEASED")) {
						clearTimeout(timeout);
						resolvePromise();
					}
				});
				child.on("exit", () => {
					clearTimeout(timeout);
					reject(new Error("helper exited early"));
				});
			});

			// The live child holds the lease: we must conflict.
			expect(() => acquireSessionLease({ sessionDir, sessionId: "cross-1" })).toThrow(SessionLeaseConflictError);
			expect(inspectSessionLease(sessionDir, "cross-1", agentDir).status).toBe("held");

			// SIGKILL leaves the lock behind; the next acquirer reclaims it.
			child.kill("SIGKILL");
			await new Promise<void>((resolvePromise) => child.on("exit", resolvePromise));
			const lease = acquireSessionLease({ sessionDir, sessionId: "cross-1" });
			lease.release();
		} finally {
			child.kill("SIGKILL");
		}
	});
});

describe("SessionManager lease integration", () => {
	it("rejects creating a session whose id is leased by another process", () => {
		const { agentDir, sessionDir } = setupDirs();
		const foreign = liveForeignProcess();
		plantForeignLease(agentDir, sessionDir, "taken-id", {
			pid: foreign.pid,
			processStart: foreign.fingerprint,
		});
		expect(() =>
			SessionManager.create(sessionDir === "" ? process.cwd() : process.cwd(), sessionDir, { id: "taken-id" }),
		).toThrow(SessionLeaseConflictError);
	});

	it("allows same-process managers on one session and releases on dispose", () => {
		const { sessionDir } = setupDirs();
		const cwd = process.cwd();
		const first = SessionManager.create(cwd, sessionDir, { id: "shared-id" });
		const second = SessionManager.create(cwd, sessionDir, { id: "shared-id" });
		const lockDir = sessionLeaseLockDir(sessionDir, "shared-id");
		expect(existsSync(lockDir)).toBe(true);
		first.dispose();
		expect(existsSync(lockDir)).toBe(true); // second manager still holds it
		second.dispose();
		expect(existsSync(lockDir)).toBe(false);
	});

	it("openReadOnly never takes the lease and rejects mutations", () => {
		const { agentDir, sessionDir } = setupDirs();
		const cwd = process.cwd();
		const writer = SessionManager.create(cwd, sessionDir, { id: "ro-id" });
		const sessionFile = writer.getSessionFile()!;
		writer.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		} as never);
		expect(existsSync(sessionFile)).toBe(true);

		// Even with a *foreign* lock (live session elsewhere), read-only works.
		writer.dispose();
		plantForeignLease(agentDir, sessionDir, "ro-id", {
			pid: liveForeignProcess().pid,
			processStart: "unverifiable",
		});
		const reader = SessionManager.openReadOnly(sessionFile);
		expect(reader.getSessionId()).toBe("ro-id");
		expect(reader.getEntries().length).toBeGreaterThan(0);
		expect(() => reader.appendMessage({ role: "user", content: "x", timestamp: Date.now() } as never)).toThrow(
			"read-only",
		);
	});

	it("derives the session id from the basename for empty explicit files", () => {
		const { sessionDir } = setupDirs();
		const explicit = join(sessionDir, "2026-08-03T10-00-00-000Z_explicit42.jsonl");
		writeFileSync(explicit, "");
		const mgr = SessionManager.open(explicit, sessionDir);
		expect(mgr.getSessionId()).toBe("explicit42");
		// The lease covers the derived id: a second writer on the same id conflicts.
		const lockDir = sessionLeaseLockDir(sessionDir, "explicit42");
		expect(existsSync(lockDir)).toBe(true);
		mgr.dispose();
	});

	it("forkFrom locks the new session id before creating the file", () => {
		const { agentDir, sessionDir } = setupDirs();
		const cwd = process.cwd();
		const source = SessionManager.create(cwd, sessionDir, { id: "src-id" });
		source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		} as never);
		const sourceFile = source.getSessionFile()!;

		const foreignFork = liveForeignProcess();
		plantForeignLease(agentDir, sessionDir, "fork-target", {
			pid: foreignFork.pid,
			processStart: foreignFork.fingerprint,
		});
		expect(() => SessionManager.forkFrom(sourceFile, cwd, sessionDir, { id: "fork-target" })).toThrow(
			SessionLeaseConflictError,
		);
		// Without a conflicting id the fork succeeds and the manager holds its lease.
		const forked = SessionManager.forkFrom(sourceFile, cwd, sessionDir, { id: "fork-ok" });
		expect(existsSync(sessionLeaseLockDir(sessionDir, "fork-ok"))).toBe(true);
		forked.dispose();
		source.dispose();
	});

	it("createBranchedSession re-keys the lease to the new session", () => {
		const { sessionDir } = setupDirs();
		const cwd = process.cwd();
		const mgr = SessionManager.create(cwd, sessionDir, { id: "branch-src" });
		mgr.appendMessage({ role: "user", content: "one", timestamp: Date.now() } as never);
		const assistantId = mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "two" }],
			timestamp: Date.now(),
		} as never);
		const oldLock = sessionLeaseLockDir(sessionDir, "branch-src");
		expect(existsSync(oldLock)).toBe(true);

		const forkedPath = mgr.createBranchedSession(assistantId);
		expect(forkedPath).toBeDefined();
		// Old identity released; new identity locked.
		expect(existsSync(oldLock)).toBe(false);
		const newId = mgr.getSessionId();
		expect(newId).not.toBe("branch-src");
		expect(existsSync(sessionLeaseLockDir(sessionDir, newId))).toBe(true);
		mgr.dispose();
	});

	it("whole-file rewrites are atomic (no temp files, valid content)", () => {
		const { sessionDir } = setupDirs();
		const cwd = process.cwd();
		const mgr = SessionManager.create(cwd, sessionDir, { id: "atomic-id" });
		mgr.appendMessage({ role: "user", content: "one", timestamp: Date.now() } as never);
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "two" }],
			timestamp: Date.now(),
		} as never);
		const file = mgr.getSessionFile()!;
		const entries = loadEntriesFromFile(file);
		expect(entries.length).toBeGreaterThanOrEqual(3); // header + 2 messages
		const leftovers = readdirSync(dirname(file)).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		mgr.dispose();
	});
});
