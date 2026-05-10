import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { dockerIsolated } from "./docker-isolated.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("dockerIsolated()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'docker-isolated'", () => {
    const provider = dockerIsolated();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("docker-isolated");
  });

  it("accepts imageName, env, and network options", () => {
    const provider = dockerIsolated({
      imageName: "my-image:latest",
      env: { MY_VAR: "hello" },
      network: ["net1", "net2"],
    });
    expect(provider.tag).toBe("isolated");
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("copies configured extra host paths into the sandbox during setup", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated({
      extraCopies: [
        {
          hostPath: "/tmp",
          sandboxPath: "/home/agent/support/host-tools",
        },
      ],
    });
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/repo",
    });

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "cp" &&
        args[1] === "/tmp" &&
        typeof args[2] === "string" &&
        args[2].endsWith(":/home/agent/support/host-tools"),
    );
    expect(cpCall).toBeDefined();

    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "exec" &&
        args.includes("mkdir") &&
        args.includes("/home/agent/support"),
    );
    expect(mkdirCall).toBeDefined();

    await handle.close();
  });

  it("runs pre-flight docker image inspect before docker run", async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        callOrder.push("inspect");
        const hostUid = process.getuid?.() ?? 1000;
        const hostGid = process.getgid?.() ?? 1000;
        callback(null, `${hostUid}:${hostGid}\n`, "");
      } else if (Array.isArray(args) && args[0] === "run") {
        callOrder.push("run");
        callback(null, "", "");
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/my-repo",
    });

    expect(callOrder).toEqual(["inspect", "run"]);
    await handle.close();
  });

  it("derives the default image name from hostRepoPath", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/My Repo",
    });

    const inspectCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "image" &&
        args[1] === "inspect",
    );
    expect(inspectCall).toBeDefined();
    expect((inspectCall![1] as string[])[2]).toBe("sandcastle:my-repo");

    await handle.close();
  });

  it("throws on UID mismatch between image and host", async () => {
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (Array.isArray(args) && args[0] === "image" && args[1] === "inspect") {
        callback(null, "9999:9999\n", "");
      } else {
        callback(null, "", "");
      }
      return undefined as any;
    });

    const provider = dockerIsolated();

    await expect(
      provider.create({
        env: {},
        hostRepoPath: "/tmp/repo",
      }),
    ).rejects.toThrow("UID mismatch");
  });

  it("starts the container without bind mounts", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/repo",
    });

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("-v");
    expect(runArgs).toContain("--user");

    await handle.close();
  });

  it("prepares the isolated worktree directory after container start", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/repo",
    });

    const mkdirCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "exec" &&
        args.some(
          (arg: string) =>
            typeof arg === "string" &&
            arg.includes("mkdir -p") &&
            arg.includes("chown"),
        ),
    );
    expect(mkdirCall).toBeDefined();
    const mkdirArgs = mkdirCall![1] as string[];
    expect(mkdirArgs).toContain("--user");
    expect(mkdirArgs[mkdirArgs.indexOf("--user") + 1]).toBe("0:0");
    expect(mkdirArgs).toContain("/home/agent/workspace");

    await handle.close();
  });

  it("copyIn creates the parent directory before docker cp", async () => {
    const callOrder: string[] = [];
    mockExecFile.mockImplementation((_command, args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      if (
        Array.isArray(args) &&
        args[0] === "exec" &&
        args[2] !== "0:0" &&
        args.includes("mkdir")
      ) {
        callOrder.push("mkdir");
      } else if (Array.isArray(args) && args[0] === "cp") {
        callOrder.push("cp");
      }
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/repo",
    });

    await handle.copyIn("/host/file.txt", "/sandbox/subdir/file.txt");

    expect(callOrder.slice(-2)).toEqual(["mkdir", "cp"]);

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "cp" &&
        args[1] === "/host/file.txt",
    );
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall![1] as string[];
    expect(cpArgs[2]).toMatch(/^sandcastle-.*:\/sandbox\/subdir\/file\.txt$/);

    await handle.close();
  });

  it("copyFileOut calls docker cp with correct arguments", async () => {
    mockExecFile.mockImplementation((_command, _args, ...rest: any[]) => {
      const callback = rest[rest.length - 1];
      callback(null, "", "");
      return undefined as any;
    });

    const provider = dockerIsolated();
    const handle = await provider.create({
      env: {},
      hostRepoPath: "/tmp/repo",
    });

    await handle.copyFileOut("/sandbox/output.txt", "/host/output.txt");

    const cpCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "docker" &&
        Array.isArray(args) &&
        args[0] === "cp" &&
        args[2] === "/host/output.txt",
    );
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall![1] as string[];
    expect(cpArgs[1]).toMatch(/^sandcastle-.*:\/sandbox\/output\.txt$/);

    await handle.close();
  });
});
