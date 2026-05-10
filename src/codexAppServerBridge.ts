import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";

type JsonRpcId = number;

interface BridgeOptions {
  readonly model: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh";
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const parseArgs = (argv: string[]): BridgeOptions => {
  let model: string | undefined;
  let effort: BridgeOptions["effort"];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      model = argv[++i];
      continue;
    }
    if (arg === "--effort") {
      const value = argv[++i];
      if (
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh"
      ) {
        effort = value;
      } else {
        throw new Error(`Unsupported --effort value: ${value ?? "(missing)"}`);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!model) {
    throw new Error("Missing required --model argument");
  }

  return { model, effort };
};

const readAllStdin = async (): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("");
};

const emit = (event: unknown): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const respond = (
  stdin: NodeJS.WritableStream,
  id: JsonRpcId,
  payload: { result?: unknown; error?: { code: number; message: string } },
): void => {
  stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...payload,
    })}\n`,
  );
};

const rejectPending = (
  pending: Map<JsonRpcId, PendingRequest>,
  error: Error,
): void => {
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
};

const fail = (message: string): never => {
  emit({ type: "error", error: { message } });
  throw new Error(message);
};

const run = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await readAllStdin();

  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<JsonRpcId, PendingRequest>();
  const agentMessages = new Map<string, string>();
  let nextId = 0;
  let threadId: string | undefined;
  let completed = false;

  const cleanup = async (): Promise<void> => {
    if (!child.killed) {
      child.kill();
    }
  };

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        })}\n`,
      );
    });
  };

  const finalize = async (result: string): Promise<void> => {
    if (completed) return;
    completed = true;
    emit({ type: "codex_app_server.result", result });
    await cleanup();
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof message.id === "number" && pending.has(message.id)) {
      const request = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "Unknown JSON-RPC error",
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (typeof message.id === "number" && typeof message.method === "string") {
      switch (message.method) {
        case "item/commandExecution/requestApproval":
          respond(child.stdin, message.id, {
            result: { decision: "accept" },
          });
          return;
        case "item/fileChange/requestApproval":
          respond(child.stdin, message.id, {
            result: { decision: "accept" },
          });
          return;
        case "item/permissions/requestApproval":
          respond(child.stdin, message.id, {
            result: { permissions: {}, scope: "session" },
          });
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          respond(child.stdin, message.id, {
            result: { decision: "approved" },
          });
          return;
        default:
          respond(child.stdin, message.id, {
            error: {
              code: -32000,
              message: `Unsupported app-server request: ${message.method}`,
            },
          });
          return;
      }
    }

    if (typeof message.method !== "string") {
      return;
    }

    switch (message.method) {
      case "thread/started":
        threadId =
          typeof message.params?.thread?.id === "string"
            ? message.params.thread.id
            : threadId;
        return;
      case "item/agentMessage/delta": {
        const itemId = message.params?.itemId;
        const delta = message.params?.delta;
        if (typeof itemId === "string" && typeof delta === "string") {
          const previous = agentMessages.get(itemId) ?? "";
          agentMessages.set(itemId, previous + delta);
          emit({ type: "codex_app_server.text_delta", text: delta });
        }
        return;
      }
      case "item/started": {
        const item = message.params?.item;
        if (
          item?.type === "commandExecution" &&
          typeof item.command === "string"
        ) {
          emit({
            type: "item.started",
            item: {
              type: "command_execution",
              command: item.command,
            },
          });
        }
        return;
      }
      case "item/completed": {
        const item = message.params?.item;
        if (
          item?.type === "agentMessage" &&
          typeof item.id === "string" &&
          typeof item.text === "string"
        ) {
          agentMessages.set(item.id, item.text);
        }
        return;
      }
      case "turn/completed": {
        const items = Array.isArray(message.params?.turn?.items)
          ? message.params.turn.items
          : [];
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            void finalize(item.text);
            return;
          }
        }
        const lastAgentMessage =
          Array.from(agentMessages.values()).at(-1) ?? "";
        void finalize(lastAgentMessage);
        return;
      }
      case "error": {
        const messageText =
          typeof message.params?.error?.message === "string"
            ? message.params.error.message
            : "Codex app-server returned an unknown error";
        emit({ type: "error", error: { message: messageText } });
        return;
      }
      default:
        return;
    }
  });

  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  child.on("error", (error) => {
    rejectPending(
      pending,
      new Error(`Failed to start codex app-server: ${error.message}`),
    );
  });

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      rl.close();
      if (completed || code === 0) {
        resolve();
        return;
      }
      const stderr = stderrChunks.join("").trim();
      reject(
        new Error(
          stderr || `codex app-server exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });

  try {
    await sendRequest("initialize", {
      clientInfo: { name: "sandcastle", version: "0.0.0" },
      capabilities: {},
    });

    const accountResult = (await sendRequest("account/read", {
      refreshToken: false,
    })) as {
      account?: { type?: string } | null;
      requiresOpenaiAuth?: boolean;
    };

    if (accountResult.account == null && accountResult.requiresOpenaiAuth) {
      fail(
        "Codex app-server is not signed in on the host. Run `codex login` and try again.",
      );
    }

    const threadResult = (await sendRequest("thread/start", {
      model: options.model,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: "sandcastle",
      ephemeral: true,
    })) as { thread?: { id?: string } };

    threadId =
      typeof threadResult.thread?.id === "string"
        ? threadResult.thread.id
        : threadId;

    if (!threadId) {
      fail("Codex app-server did not return a thread id");
    }

    await sendRequest("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: options.model,
      effort: options.effort,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });

    await exitPromise;

    if (!completed) {
      fail("Codex app-server exited before completing the turn");
    }
  } finally {
    rejectPending(
      pending,
      new Error("Codex app-server bridge stopped before the request completed"),
    );
    await cleanup();
  }
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Codex app-server is not signed in")) {
    emit({ type: "error", error: { message } });
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
