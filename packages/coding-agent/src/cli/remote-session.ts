import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionLeaseConflictError } from "../core/session-lease.ts";

const execFileAsync = promisify(execFile);

/**
 * Stop a pi-remote-managed writer before retrying a local session open.
 *
 * The remote CLI owns the tmux/runtime identity checks and waits for the Pi
 * core lease to be released. The local process never removes a lease file.
 */
export async function stopRemoteSession(owner: SessionLeaseConflictError["owner"]): Promise<void> {
	if (!owner.runtimeId) {
		throw new Error("the session is not owned by a pi-remote runtime");
	}

	const command = process.env.PI_REMOTE_CLI?.trim() || "pi-remote";
	const args = ["stop-session", owner.sessionId, "--runtime-id", owner.runtimeId];
	if (owner.runtimeDir) args.push("--runtime-dir", owner.runtimeDir);
	try {
		await execFileAsync(command, args, {
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 256 * 1024,
		});
	} catch (error: unknown) {
		const detail = error as { stderr?: string; message?: string };
		const message = detail.stderr?.trim() || detail.message || "unknown error";
		throw new Error(`could not stop the remote session: ${message}`);
	}
}
