import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path.endsWith("auth.json")),
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    default: actual,
    join: actual.win32.join,
  };
});

import { codexCliMounts } from "./codexCliMounts.js";

describe("codexCliMounts on Windows-style hosts", () => {
  it("keeps sandbox paths POSIX even when host path joins use backslashes", () => {
    expect(
      codexCliMounts({
        hostCodexDir: "C:\\Users\\alice\\.codex",
      }),
    ).toEqual([
      {
        hostPath: "C:\\Users\\alice\\.codex\\auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
    ]);
  });
});
