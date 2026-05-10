/** Minimal type declarations for @daytona/sdk (optional peer dependency). */
declare module "@daytona/sdk" {
  export interface DaytonaConfig {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
  }

  export interface CreateSandboxFromImageParams {
    image?: string;
    envVars?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface CreateSandboxFromSnapshotParams {
    snapshot?: string;
    envVars?: Record<string, string>;
    [key: string]: unknown;
  }

  export interface DaytonaSandbox {
    getWorkDir(): Promise<string | undefined>;
    getUserHomeDir(): Promise<string | undefined>;
    process: {
      createSession(sessionId: string): Promise<void>;
      executeSessionCommand(
        sessionId: string,
        options: {
          command: string;
          async?: boolean;
        },
      ): Promise<{ cmdId?: string }>;
      getSessionCommandLogs(
        sessionId: string,
        cmdId: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void,
      ): Promise<void>;
      getSessionCommand(
        sessionId: string,
        cmdId: string,
      ): Promise<{ exitCode?: number }>;
      deleteSession(sessionId: string): Promise<void>;
      executeCommand(
        command: string,
        cwd?: string,
      ): Promise<{ result: string; exitCode: number }>;
    };
    fs: {
      uploadFile(hostPath: string, sandboxPath: string): Promise<void>;
      downloadFile(sandboxPath: string, hostPath: string): Promise<void>;
    };
  }

  export class Daytona {
    constructor(config?: DaytonaConfig);
    create(
      options?: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams,
    ): Promise<DaytonaSandbox>;
    delete(sandbox: DaytonaSandbox): Promise<void>;
  }
}
