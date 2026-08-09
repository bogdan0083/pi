import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(testDir, "..");
const stubAgent = join(testDir, "stub-agent.mjs");
const extension = join(rootDir, "agent/extensions/voice-input.ts");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: pathToFileURL(stubAgent).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const pi = {
  on(event, handler) {
    this.handlers[event] = handler;
  },
  handlers: {},
  registerCommand() {},
};

const mod = await import(pathToFileURL(extension).href);
mod.default(pi);
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
pi.handlers.session_start({}, {
  cwd: undefined,
  isProjectTrusted: () => false,
  mode: "tui",
  hasUI: true,
  ui: {
    onTerminalInput: () => () => {},
    notify() {},
    setStatus() {},
    pasteToEditor() {},
    getEditorText: () => "",
  },
});

// Exit without session_shutdown. The output captured by the parent must still
// contain the two synchronous restoration sequences from the process exit hook.
process.exit(0);
