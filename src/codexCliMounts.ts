import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { MountConfig } from "./MountConfig.js";

export interface CodexCliMountsOptions {
  /**
   * Host-side `.codex` directory to read credentials/config from.
   *
   * Defaults to `~/.codex`.
   */
  readonly hostCodexDir?: string;
  /**
   * Sandbox-side `.codex` directory where files should be mounted.
   *
   * Defaults to `/home/agent/.codex`, which matches the built-in Docker and
   * Podman images.
   */
  readonly sandboxCodexDir?: string;
  /**
   * Mount files as read-only.
   *
   * Defaults to `true` because Sandcastle only needs to read the host auth and
   * config files inside the sandbox.
   */
  readonly readonly?: boolean;
}

const CODEX_FILE_CANDIDATES = [
  "auth.json",
  "config.toml",
  // Kept for compatibility with older/local setups that may still use JSON.
  "config.json",
] as const;

/**
 * Mount the host Codex CLI auth/config files into a bind-mount sandbox.
 *
 * This is useful when Sandcastle runs Codex inside Docker/Podman and you want
 * it to reuse credentials created by `codex --login` on the host.
 */
export const codexCliMounts = (
  options?: CodexCliMountsOptions,
): MountConfig[] => {
  const hostCodexDir = options?.hostCodexDir ?? join(homedir(), ".codex");
  const sandboxCodexDir = options?.sandboxCodexDir ?? "/home/agent/.codex";
  const readonly = options?.readonly ?? true;

  return CODEX_FILE_CANDIDATES.flatMap((filename) => {
    const hostPath = join(hostCodexDir, filename);
    if (!existsSync(hostPath)) return [];

    return [
      {
        hostPath,
        sandboxPath: posix.join(sandboxCodexDir, filename),
        readonly,
      },
    ];
  });
};
