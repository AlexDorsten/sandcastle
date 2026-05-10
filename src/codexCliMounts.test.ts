import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexCliMounts } from "./codexCliMounts.js";

describe("codexCliMounts", () => {
  it("returns mounts for auth.json and config.toml when present", () => {
    const hostCodexDir = mkdtempSync(join(tmpdir(), "codex-mounts-"));
    writeFileSync(join(hostCodexDir, "auth.json"), "{}");
    writeFileSync(join(hostCodexDir, "config.toml"), 'model = "gpt-5.4"');

    expect(codexCliMounts({ hostCodexDir })).toEqual([
      {
        hostPath: join(hostCodexDir, "auth.json"),
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
      {
        hostPath: join(hostCodexDir, "config.toml"),
        sandboxPath: "/home/agent/.codex/config.toml",
        readonly: true,
      },
    ]);
  });

  it("skips missing files", () => {
    const hostCodexDir = mkdtempSync(join(tmpdir(), "codex-mounts-"));
    writeFileSync(join(hostCodexDir, "auth.json"), "{}");

    expect(codexCliMounts({ hostCodexDir })).toEqual([
      {
        hostPath: join(hostCodexDir, "auth.json"),
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
    ]);
  });

  it("supports overriding the sandbox path and readonly flag", () => {
    const hostCodexDir = mkdtempSync(join(tmpdir(), "codex-mounts-"));
    mkdirSync(hostCodexDir, { recursive: true });
    writeFileSync(join(hostCodexDir, "config.json"), "{}");

    expect(
      codexCliMounts({
        hostCodexDir,
        sandboxCodexDir: "/tmp/codex",
        readonly: false,
      }),
    ).toEqual([
      {
        hostPath: join(hostCodexDir, "config.json"),
        sandboxPath: "/tmp/codex/config.json",
        readonly: false,
      },
    ]);
  });
});
