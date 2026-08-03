/**
 * Test helper: acquire a session write lease, signal readiness on stdout,
 * then stay alive until killed. Used by session-lease.test.ts to exercise
 * real cross-process conflicts and SIGKILL stale reclamation.
 *
 * Usage: node session-lease-holder.ts <sessionDir> <sessionId>
 * Env: PI_CODING_AGENT_DIR must point at the test agent dir.
 */
import { acquireSessionLease } from "../../src/core/session-lease.ts";

const [sessionDir, sessionId] = process.argv.slice(2);
if (!sessionDir || !sessionId) {
	console.error("usage: session-lease-holder <sessionDir> <sessionId>");
	process.exit(64);
}

acquireSessionLease({ sessionDir, sessionId });
process.stdout.write("LEASED\n");

// Stay alive; the test kills us (SIGKILL) to simulate a crash.
setInterval(() => {}, 60_000);
