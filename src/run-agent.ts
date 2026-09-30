import { runAgent as runClaudeCode } from "./start-claude-code";
import { runAgent as runCodex } from "./start-codex";
import { runAgent as runOpencode } from "./start-opencode";
import { emitEvent, notifyPermissionsChanged, type SessionStore } from "./server-common";

/** Shared dispatch for browser turns and server-owned analysis runs. */
export function launchAgent(store: SessionStore): void {
  const run = store.agent === "claude-code" ? runClaudeCode : store.agent === "codex" ? runCodex : runOpencode;
  run(store).catch((error: unknown) => {
    console.error("[runAgent] unhandled:", error);
    if (store.status !== "running") return;
    store.status = "error";
    emitEvent(store, "error", { message: error instanceof Error ? error.message : `${store.agent} failed to start` });
    notifyPermissionsChanged();
  });
}
