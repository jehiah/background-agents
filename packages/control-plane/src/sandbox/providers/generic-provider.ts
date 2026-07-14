/**
 * Generic sandbox provider.
 *
 * Implements the SandboxProvider interface against any backend that speaks the
 * protocol documented in docs/SANDBOX_PROTOCOL.md, via GenericSandboxClient (a
 * configurable base URL + static bearer token).
 *
 * Capabilities are configured per deployment: a backend that does not implement
 * the snapshot/restore commands simply leaves those capabilities off, and the
 * corresponding optional methods are not exposed (the lifecycle manager gates on
 * method presence, so it never attempts an unsupported operation).
 */

import { GenericSandboxApiError, type GenericSandboxClient } from "../generic-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

/**
 * Capability configuration for a generic provider deployment.
 *
 * Defaults model a persistent, VM-style backend: it can resume and stop
 * sandboxes in place, but does not implement filesystem snapshots, restore, or
 * warm pools. Each flag can be overridden to match the backend's capabilities.
 */
export interface GenericProviderConfig {
  supportsSandboxTimeout?: boolean;
  supportsSnapshots?: boolean;
  supportsRestore?: boolean;
  supportsPersistentResume?: boolean;
  supportsExplicitStop?: boolean;
}

export class GenericSandboxProvider implements SandboxProvider {
  readonly name = "generic";

  readonly capabilities: SandboxProviderCapabilities;

  // Optional methods are attached in the constructor only when the matching
  // capability is enabled, so the lifecycle manager's method-presence checks
  // correctly skip operations the backend doesn't implement.
  restoreFromSnapshot?: (config: RestoreConfig) => Promise<RestoreResult>;
  takeSnapshot?: (config: SnapshotConfig) => Promise<SnapshotResult>;
  resumeSandbox?: (config: ResumeConfig) => Promise<ResumeResult>;
  stopSandbox?: (config: StopConfig) => Promise<StopResult>;

  constructor(
    private readonly client: GenericSandboxClient,
    config: GenericProviderConfig = {}
  ) {
    this.capabilities = {
      supportsSandboxTimeout: config.supportsSandboxTimeout ?? true,
      supportsSnapshots: config.supportsSnapshots ?? false,
      supportsRestore: config.supportsRestore ?? false,
      supportsPersistentResume: config.supportsPersistentResume ?? true,
      supportsExplicitStop: config.supportsExplicitStop ?? true,
    };

    if (this.capabilities.supportsRestore) {
      this.restoreFromSnapshot = (c) => this.doRestoreFromSnapshot(c);
    }
    if (this.capabilities.supportsSnapshots) {
      this.takeSnapshot = (c) => this.doTakeSnapshot(c);
    }
    if (this.capabilities.supportsPersistentResume) {
      this.resumeSandbox = (c) => this.doResumeSandbox(c);
    }
    if (this.capabilities.supportsExplicitStop) {
      this.stopSandbox = (c) => this.doStopSandbox(c);
    }
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    try {
      const result = await this.client.createSandbox(
        {
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          repoOwner: config.repoOwner,
          repoName: config.repoName,
          repositories: config.repositories,
          controlPlaneUrl: config.controlPlaneUrl,
          sandboxAuthToken: config.sandboxAuthToken,
          agentSessionId: config.agentSessionId,
          harness: config.harness,
          provider: config.provider,
          model: config.model,
          userEnvVars: config.userEnvVars,
          prebuiltImageId: config.prebuiltImageId,
          prebuiltImageSha: config.prebuiltImageSha,
          timeoutSeconds,
          branch: config.branch,
          codeServerEnabled: config.codeServerEnabled,
          agentSlackNotifyEnabled: config.agentSlackNotifyEnabled,
          mcpServers: config.mcpServers,
          sandboxSettings: config.sandboxSettings,
        },
        config.correlation
      );

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.providerObjectId,
        createdAt: result.createdAt,
        lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
        codeServerUrl: result.codeServerUrl,
        codeServerPassword: result.codeServerPassword,
        ttydUrl: result.ttydUrl,
        tunnelUrls: result.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create generic sandbox", error);
    }
  }

  private async doRestoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    try {
      const result = await this.client.restoreSandbox(
        {
          snapshotImageId: config.snapshotImageId,
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          sandboxAuthToken: config.sandboxAuthToken,
          controlPlaneUrl: config.controlPlaneUrl,
          repoOwner: config.repoOwner,
          repoName: config.repoName,
          repositories: config.repositories,
          provider: config.provider,
          model: config.model,
          userEnvVars: config.userEnvVars,
          timeoutSeconds,
          branch: config.branch,
          codeServerEnabled: config.codeServerEnabled,
          agentSlackNotifyEnabled: config.agentSlackNotifyEnabled,
          mcpServers: config.mcpServers,
          sandboxSettings: config.sandboxSettings,
        },
        config.correlation
      );

      if (result.success) {
        return {
          success: true,
          sandboxId: result.sandboxId,
          providerObjectId: result.providerObjectId,
          lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
          codeServerUrl: result.codeServerUrl,
          codeServerPassword: result.codeServerPassword,
          ttydUrl: result.ttydUrl,
          tunnelUrls: result.tunnelUrls,
        };
      }
      return { success: false, error: result.error || "Unknown restore error" };
    } catch (error) {
      throw this.classifyError("Failed to restore generic sandbox from snapshot", error);
    }
  }

  private async doTakeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const result = await this.client.snapshotSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          reason: config.reason,
        },
        config.correlation
      );

      if (result.success && result.imageId) {
        return { success: true, imageId: result.imageId };
      }
      return { success: false, error: result.error || "Unknown snapshot error" };
    } catch (error) {
      throw this.classifyError("Failed to take generic sandbox snapshot", error);
    }
  }

  private async doResumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const observedAtMs = Date.now();
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    try {
      const result = await this.client.resumeSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          timeoutSeconds,
          codeServerEnabled: config.codeServerEnabled,
          sandboxSettings: config.sandboxSettings,
        },
        config.correlation
      );

      if (result.success) {
        return {
          success: true,
          providerObjectId: result.providerObjectId,
          lifetime: this.lifetimeFrom(observedAtMs, timeoutSeconds),
          codeServerUrl: result.codeServerUrl,
          codeServerPassword: result.codeServerPassword,
          ttydUrl: result.ttydUrl,
          tunnelUrls: result.tunnelUrls,
        };
      }
      return {
        success: false,
        error: result.error || "Unknown resume error",
        shouldSpawnFresh: result.shouldSpawnFresh,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume generic sandbox", error);
    }
  }

  private async doStopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      const result = await this.client.stopSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          reason: config.reason,
          intent: config.intent,
          signal: signalUntilDeadline(config.deadlineAtMs, config.signal),
        },
        config.correlation
      );

      if (result.success) {
        return { success: true };
      }
      return { success: false, error: result.error || "Unknown stop error" };
    } catch (error) {
      throw this.classifyError("Failed to stop generic sandbox", error);
    }
  }

  /**
   * The protocol has no expiry field, so the lifetime is derived from the
   * requested timeout rather than observed: a backend that enforces sandbox
   * timeouts stops at latest that far out (a conservative start bound), and one
   * that does not enforce them has no expiry to report at all.
   */
  private lifetimeFrom(observedAtMs: number, timeoutSeconds: number): SandboxLifetime {
    if (!this.capabilities.supportsSandboxTimeout) {
      return { kind: "none", observedAtMs };
    }
    return {
      kind: "finite",
      expiresAtMs: observedAtMs + timeoutSeconds * 1000,
      observedAtMs,
      source: "conservative_start_bound",
    };
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) {
      return error;
    }
    if (error instanceof GenericSandboxApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

/**
 * Create a generic sandbox provider.
 */
export function createGenericProvider(
  client: GenericSandboxClient,
  config: GenericProviderConfig = {}
): GenericSandboxProvider {
  return new GenericSandboxProvider(client, config);
}
