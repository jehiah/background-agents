/**
 * Generic sandbox HTTP client.
 *
 * Speaks the provider protocol documented in SANDBOX_PROTOCOL.md against any
 * backend that exposes it at a configurable base URL. Unlike ModalClient
 * (workspace-derived URLs, HMAC-signed tokens), this client targets a single
 * base URL and authenticates with a static bearer token, so it can drive any
 * conforming provider (e.g. a self-hosted GCP sandbox bridge).
 *
 * Wire format mirrors the upstream Modal protocol — snake_case JSON fields and
 * a `{ success, data, error }` envelope — but uses the provider-neutral
 * `provider_object_id` rather than Modal's `modal_object_id`.
 */

import type { McpServerConfig, SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";

const log = createLogger("generic-sandbox-client");

// ---------------------------------------------------------------------------
// Endpoint paths (operation-oriented, relative to the configured base URL)
// ---------------------------------------------------------------------------

const PATH_CREATE = "/sandbox/create";
const PATH_RESTORE = "/sandbox/restore";
const PATH_SNAPSHOT = "/sandbox/snapshot";
const PATH_RESUME = "/sandbox/resume";
const PATH_STOP = "/sandbox/stop";
const PATH_HEALTH = "/health";

// ---------------------------------------------------------------------------
// Per-operation timeouts (ms)
// ---------------------------------------------------------------------------

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_RESTORE_MS = 90_000;
const TIMEOUT_SNAPSHOT_MS = 120_000;
const TIMEOUT_RESUME_MS = 60_000;
const TIMEOUT_STOP_MS = 30_000;
const TIMEOUT_HEALTH_MS = 15_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GenericSandboxClientConfig {
  /** Provider base URL (e.g. "https://sandbox.example.com/api"). */
  baseUrl: string;
  /** Static bearer token sent as `Authorization: Bearer <token>`. */
  bearerToken: string;
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface CreateSandboxRequest {
  sessionId: string;
  sandboxId?: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider?: string;
  model?: string;
  userEnvVars?: Record<string, string>;
  opencodeSessionId?: string;
  repoImageId?: string | null;
  repoImageSha?: string | null;
  timeoutSeconds?: number;
  branch?: string;
  codeServerEnabled?: boolean;
  agentSlackNotifyEnabled?: boolean;
  mcpServers?: McpServerConfig[];
  sandboxSettings?: SandboxSettings;
}

export interface RestoreSandboxRequest {
  snapshotImageId: string;
  sessionId: string;
  sandboxId: string;
  sandboxAuthToken: string;
  controlPlaneUrl: string;
  repoOwner: string;
  repoName: string;
  provider: string;
  model: string;
  userEnvVars?: Record<string, string>;
  timeoutSeconds?: number;
  branch?: string;
  codeServerEnabled?: boolean;
  agentSlackNotifyEnabled?: boolean;
  mcpServers?: McpServerConfig[];
  sandboxSettings?: SandboxSettings;
}

export interface SnapshotSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  reason: string;
}

export interface ResumeSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  sandboxId: string;
  timeoutSeconds?: number;
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings;
}

export interface StopSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface CreateSandboxResponse {
  sandboxId: string;
  providerObjectId?: string;
  status: string;
  createdAt: number;
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export interface RestoreSandboxResponse {
  success: boolean;
  sandboxId?: string;
  providerObjectId?: string;
  error?: string;
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export interface SnapshotSandboxResponse {
  success: boolean;
  imageId?: string;
  error?: string;
}

export interface ResumeSandboxResponse {
  success: boolean;
  providerObjectId?: string;
  shouldSpawnFresh?: boolean;
  error?: string;
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export interface StopSandboxResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Envelope + errors
// ---------------------------------------------------------------------------

interface GenericApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Thrown when the provider returns a non-OK HTTP status. Carries the numeric
 * status so callers can classify transient vs permanent without string parsing.
 */
export class GenericSandboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GenericSandboxApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class GenericSandboxClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;

  constructor(config: GenericSandboxClientConfig) {
    if (!config.baseUrl) {
      throw new Error("GenericSandboxClient requires baseUrl");
    }
    if (!config.bearerToken) {
      throw new Error("GenericSandboxClient requires bearerToken");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.bearerToken = config.bearerToken;
  }

  async createSandbox(
    request: CreateSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<CreateSandboxResponse> {
    const data = await this.request<{
      sandbox_id: string;
      provider_object_id?: string;
      status: string;
      created_at: number;
      code_server_url?: string;
      code_server_password?: string;
      ttyd_url?: string;
      tunnel_urls?: Record<string, string>;
    }>(
      PATH_CREATE,
      TIMEOUT_CREATE_MS,
      {
        session_id: request.sessionId,
        sandbox_id: request.sandboxId || null,
        repo_owner: request.repoOwner,
        repo_name: request.repoName,
        control_plane_url: request.controlPlaneUrl,
        sandbox_auth_token: request.sandboxAuthToken,
        opencode_session_id: request.opencodeSessionId || null,
        provider: request.provider || "anthropic",
        model: request.model || "claude-sonnet-4-6",
        user_env_vars: request.userEnvVars || null,
        repo_image_id: request.repoImageId || null,
        repo_image_sha: request.repoImageSha || null,
        timeout_seconds: request.timeoutSeconds || null,
        branch: request.branch || null,
        code_server_enabled: request.codeServerEnabled ?? false,
        agent_slack_notify_enabled: request.agentSlackNotifyEnabled ?? false,
        mcp_servers: request.mcpServers || null,
        sandbox_settings: request.sandboxSettings ?? null,
      },
      { endpoint: "createSandbox", sessionId: request.sessionId, sandboxId: request.sandboxId },
      correlation
    );

    if (!data) {
      throw new Error("Create response missing data");
    }

    return {
      sandboxId: data.sandbox_id,
      providerObjectId: data.provider_object_id,
      status: data.status,
      createdAt: data.created_at,
      codeServerUrl: data.code_server_url,
      codeServerPassword: data.code_server_password,
      ttydUrl: data.ttyd_url,
      tunnelUrls: data.tunnel_urls,
    };
  }

  async restoreSandbox(
    request: RestoreSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<RestoreSandboxResponse> {
    const { data, error } = await this.requestEnvelope<{
      sandbox_id?: string;
      provider_object_id?: string;
      code_server_url?: string;
      code_server_password?: string;
      ttyd_url?: string;
      tunnel_urls?: Record<string, string>;
    }>(
      PATH_RESTORE,
      TIMEOUT_RESTORE_MS,
      {
        snapshot_image_id: request.snapshotImageId,
        session_config: {
          session_id: request.sessionId,
          repo_owner: request.repoOwner,
          repo_name: request.repoName,
          provider: request.provider,
          model: request.model,
          branch: request.branch || null,
          mcp_servers: request.mcpServers || null,
        },
        sandbox_id: request.sandboxId,
        control_plane_url: request.controlPlaneUrl,
        sandbox_auth_token: request.sandboxAuthToken,
        user_env_vars: request.userEnvVars || null,
        timeout_seconds: request.timeoutSeconds || null,
        code_server_enabled: request.codeServerEnabled ?? false,
        agent_slack_notify_enabled: request.agentSlackNotifyEnabled ?? false,
        sandbox_settings: request.sandboxSettings ?? null,
      },
      { endpoint: "restoreSandbox", sessionId: request.sessionId, sandboxId: request.sandboxId },
      correlation
    );

    if (error !== undefined) {
      return { success: false, error: error || "Unknown restore error" };
    }

    return {
      success: true,
      sandboxId: data?.sandbox_id,
      providerObjectId: data?.provider_object_id,
      codeServerUrl: data?.code_server_url,
      codeServerPassword: data?.code_server_password,
      ttydUrl: data?.ttyd_url,
      tunnelUrls: data?.tunnel_urls,
    };
  }

  async snapshotSandbox(
    request: SnapshotSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<SnapshotSandboxResponse> {
    const { data, error } = await this.requestEnvelope<{ image_id?: string }>(
      PATH_SNAPSHOT,
      TIMEOUT_SNAPSHOT_MS,
      {
        provider_object_id: request.providerObjectId,
        session_id: request.sessionId,
        reason: request.reason,
      },
      {
        endpoint: "snapshotSandbox",
        sessionId: request.sessionId,
        sandboxId: request.providerObjectId,
      },
      correlation
    );

    if (error !== undefined) {
      return { success: false, error: error || "Unknown snapshot error" };
    }
    if (!data?.image_id) {
      return { success: false, error: "Snapshot response missing image_id" };
    }
    return { success: true, imageId: data.image_id };
  }

  async resumeSandbox(
    request: ResumeSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<ResumeSandboxResponse> {
    const { data, error } = await this.requestEnvelope<{
      provider_object_id?: string;
      should_spawn_fresh?: boolean;
      code_server_url?: string;
      code_server_password?: string;
      ttyd_url?: string;
      tunnel_urls?: Record<string, string>;
    }>(
      PATH_RESUME,
      TIMEOUT_RESUME_MS,
      {
        provider_object_id: request.providerObjectId,
        session_id: request.sessionId,
        sandbox_id: request.sandboxId,
        timeout_seconds: request.timeoutSeconds || null,
        code_server_enabled: request.codeServerEnabled ?? false,
        sandbox_settings: request.sandboxSettings ?? null,
      },
      { endpoint: "resumeSandbox", sessionId: request.sessionId, sandboxId: request.sandboxId },
      correlation
    );

    if (error !== undefined) {
      return {
        success: false,
        error: error || "Unknown resume error",
        shouldSpawnFresh: data?.should_spawn_fresh,
      };
    }

    return {
      success: true,
      providerObjectId: data?.provider_object_id,
      shouldSpawnFresh: data?.should_spawn_fresh,
      codeServerUrl: data?.code_server_url,
      codeServerPassword: data?.code_server_password,
      ttydUrl: data?.ttyd_url,
      tunnelUrls: data?.tunnel_urls,
    };
  }

  async stopSandbox(
    request: StopSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<StopSandboxResponse> {
    const { error } = await this.requestEnvelope<unknown>(
      PATH_STOP,
      TIMEOUT_STOP_MS,
      {
        provider_object_id: request.providerObjectId,
        session_id: request.sessionId,
        reason: request.reason,
      },
      {
        endpoint: "stopSandbox",
        sessionId: request.sessionId,
        sandboxId: request.providerObjectId,
      },
      correlation
    );

    if (error !== undefined) {
      return { success: false, error: error || "Unknown stop error" };
    }
    return { success: true };
  }

  /**
   * Check provider health. Does not require authentication.
   */
  async health(): Promise<{ status: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_HEALTH_MS);
    try {
      const response = await fetch(`${this.baseUrl}${PATH_HEALTH}`, { signal: controller.signal });
      if (!response.ok) {
        throw new GenericSandboxApiError(
          `Generic sandbox API error: ${response.status}`,
          response.status
        );
      }
      const result = (await response.json()) as GenericApiResponse<{ status: string }>;
      if (!result.success || !result.data) {
        throw new Error(`Generic sandbox API error: ${result.error || "Unknown error"}`);
      }
      return result.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getHeaders(correlation?: CorrelationContext): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.bearerToken}`,
    };
    if (correlation?.trace_id) headers["x-trace-id"] = correlation.trace_id;
    if (correlation?.request_id) headers["x-request-id"] = correlation.request_id;
    if (correlation?.session_id) headers["x-session-id"] = correlation.session_id;
    if (correlation?.sandbox_id) headers["x-sandbox-id"] = correlation.sandbox_id;
    return headers;
  }

  /**
   * POST a request and return the full `{ data, error }` envelope. Used by
   * operations whose protocol response carries an application-level `error`
   * (restore/snapshot/resume/stop) that should surface as a failure result
   * rather than a thrown exception.
   */
  private async requestEnvelope<T>(
    path: string,
    timeoutMs: number,
    body: unknown,
    logFields: { endpoint: string; sessionId?: string; sandboxId?: string },
    correlation?: CorrelationContext
  ): Promise<{ data?: T; error?: string }> {
    const startTime = Date.now();
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.getHeaders(correlation),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new GenericSandboxApiError(
          `Generic sandbox API error: ${response.status} ${text}`,
          response.status
        );
      }

      const result = (await response.json()) as GenericApiResponse<T>;
      if (!result.success) {
        // Surface data alongside the error: some operations (resume) include
        // fields like should_spawn_fresh on a failed response.
        return { data: result.data, error: result.error || "Unknown error" };
      }
      outcome = "success";
      return { data: result.data };
    } finally {
      clearTimeout(timeoutId);
      log.info("generic_sandbox.request", {
        event: "generic_sandbox.request",
        endpoint: logFields.endpoint,
        session_id: logFields.sessionId,
        sandbox_id: logFields.sandboxId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * POST a request that must succeed (create). A `success: false` envelope or
   * non-OK status throws rather than returning a failure result.
   */
  private async request<T>(
    path: string,
    timeoutMs: number,
    body: unknown,
    logFields: { endpoint: string; sessionId?: string; sandboxId?: string },
    correlation?: CorrelationContext
  ): Promise<T | undefined> {
    const { data, error } = await this.requestEnvelope<T>(
      path,
      timeoutMs,
      body,
      logFields,
      correlation
    );
    if (error !== undefined) {
      throw new Error(`Generic sandbox API error: ${error}`);
    }
    return data;
  }
}

/**
 * Create a new generic sandbox client instance.
 */
export function createGenericSandboxClient(
  config: GenericSandboxClientConfig
): GenericSandboxClient {
  return new GenericSandboxClient(config);
}
