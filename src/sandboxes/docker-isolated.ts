/**
 * Docker isolated sandbox provider — copies the repo into a Docker container
 * instead of bind-mounting it from the host.
 *
 * Useful on Docker Desktop setups where external host paths (for example
 * `/Volumes/...` on macOS) are not mounted reliably into containers.
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { startContainer, removeContainer } from "../DockerLifecycle.js";
import { SANDBOX_REPO_DIR } from "../SandboxFactory.js";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type InteractiveExecOptions,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";
import { defaultImageName } from "../mountUtils.js";
import { checkDockerImageUid } from "./dockerShared.js";

export interface DockerIsolatedOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * The UID of the `agent` user inside the container image (default: host UID
   * via `process.getuid()`, or 1000).
   */
  readonly containerUid?: number;
  /**
   * The GID of the `agent` user inside the container image (default: host GID
   * via `process.getgid()`, or 1000).
   */
  readonly containerGid?: number;
  /** Environment variables injected by this provider. */
  readonly env?: Record<string, string>;
  /**
   * Docker network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   */
  readonly network?: string | readonly string[];
}

export const dockerIsolated = (
  options?: DockerIsolatedOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "docker-isolated",
    env: options?.env,
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;
      const imageName =
        options?.imageName ??
        defaultImageName(createOptions.hostRepoPath ?? process.cwd() ?? ".");
      const containerUid = options?.containerUid ?? process.getuid?.() ?? 1000;
      const containerGid = options?.containerGid ?? process.getgid?.() ?? 1000;

      await checkDockerImageUid(imageName, containerUid, "dockerIsolated");

      await Effect.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            workdir: "/home/agent",
            user: `${containerUid}:${containerGid}`,
            network: options?.network,
          },
        ),
      );

      await new Promise<void>((resolve, reject) => {
        execFile(
          "docker",
          [
            "exec",
            "--user",
            "0:0",
            containerName,
            "sh",
            "-c",
            `mkdir -p "$1" && chown "$2" "$1"`,
            "sh",
            SANDBOX_REPO_DIR,
            `${containerUid}:${containerGid}`,
          ],
          (error) => {
            if (error) {
              reject(
                new Error(
                  `Failed to prepare isolated worktree '${SANDBOX_REPO_DIR}' in container: ${error.message}`,
                ),
              );
            } else {
              resolve();
            }
          },
        );
      });

      const onExit = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const onSignal = () => {
        onExit();
        process.exit(1);
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      return {
        worktreePath: SANDBOX_REPO_DIR,

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, {
              stdio: [
                opts?.stdin !== undefined ? "pipe" : "ignore",
                "pipe",
                "pipe",
              ],
            });

            if (opts?.stdin !== undefined) {
              proc.stdin!.write(opts.stdin);
              proc.stdin!.end();
            }

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            if (opts?.onLine) {
              const onLine = opts.onLine;
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });
            } else {
              proc.stdout!.on("data", (chunk: Buffer) => {
                stdoutChunks.push(chunk.toString());
              });
            }

            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join(opts?.onLine ? "\n" : ""),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const dockerArgs = ["exec"];
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              dockerArgs.push("-it");
            } else {
              dockerArgs.push("-i");
            }
            if (opts.cwd) dockerArgs.push("-w", opts.cwd);
            dockerArgs.push(containerName, ...args);

            const proc = spawn("docker", dockerArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const sandboxParent = posix.dirname(sandboxPath);
          await new Promise<void>((resolve, reject) => {
            execFile(
              "docker",
              ["exec", containerName, "mkdir", "-p", sandboxParent],
              (error) => {
                if (error) {
                  reject(
                    new Error(
                      `Failed to create sandbox parent '${sandboxParent}': ${error.message}`,
                    ),
                  );
                } else {
                  resolve();
                }
              },
            );
          });

          await new Promise<void>((resolve, reject) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (in) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          });
        },

        copyFileOut: (sandboxPath: string, hostPath: string): Promise<void> =>
          new Promise((resolve, reject) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  reject(new Error(`docker cp (out) failed: ${error.message}`));
                } else {
                  resolve();
                }
              },
            );
          }),

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await Effect.runPromise(removeContainer(containerName));
        },
      };
    },
  });

export { defaultImageName };
