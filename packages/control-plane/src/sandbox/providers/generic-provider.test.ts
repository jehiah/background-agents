/**
 * Unit tests for GenericSandboxProvider.
 *
 * Covers capability-driven method exposure, create/resume/stop/snapshot/restore
 * delegation to the client, and error classification.
 */

import { describe, it, expect, vi } from "vitest";
import { GenericSandboxProvider } from "./generic-provider";
import { GenericSandboxApiError, type GenericSandboxClient } from "../generic-client";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";

function createMockClient(overrides: Partial<GenericSandboxClient> = {}): GenericSandboxClient {
  return {
    createSandbox: vi.fn(async () => ({
      sandboxId: "sbx-1",
      providerObjectId: "obj-1",
      status: "running",
      createdAt: 1000,
    })),
    restoreSandbox: vi.fn(async () => ({ success: true, sandboxId: "sbx-1" })),
    snapshotSandbox: vi.fn(async () => ({ success: true, imageId: "img-1" })),
    resumeSandbox: vi.fn(async () => ({ success: true, providerObjectId: "obj-1" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    health: vi.fn(async () => ({ status: "ok" })),
    ...overrides,
  } as unknown as GenericSandboxClient;
}

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sbx-1",
  repoOwner: "acme",
  repoName: "widgets",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("GenericSandboxProvider capabilities", () => {
  it("defaults to a persistent backend without snapshots", () => {
    const provider = new GenericSandboxProvider(createMockClient());
    expect(provider.capabilities).toEqual({
      supportsSandboxTimeout: true,
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
    // Optional methods reflect capabilities so the lifecycle manager skips
    // unsupported operations.
    expect(provider.takeSnapshot).toBeUndefined();
    expect(provider.restoreFromSnapshot).toBeUndefined();
    expect(provider.resumeSandbox).toBeTypeOf("function");
    expect(provider.stopSandbox).toBeTypeOf("function");
  });

  it("exposes snapshot and restore methods only when enabled", () => {
    const provider = new GenericSandboxProvider(createMockClient(), {
      supportsSnapshots: true,
      supportsRestore: true,
    });
    expect(provider.takeSnapshot).toBeTypeOf("function");
    expect(provider.restoreFromSnapshot).toBeTypeOf("function");
  });

  it("hides resume and stop methods when disabled", () => {
    const provider = new GenericSandboxProvider(createMockClient(), {
      supportsPersistentResume: false,
      supportsExplicitStop: false,
    });
    expect(provider.resumeSandbox).toBeUndefined();
    expect(provider.stopSandbox).toBeUndefined();
  });
});

describe("GenericSandboxProvider.createSandbox", () => {
  it("delegates to the client and maps the result", async () => {
    const client = createMockClient();
    const provider = new GenericSandboxProvider(client);

    const result = await provider.createSandbox(baseCreateConfig);

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", sandboxId: "sbx-1" }),
      undefined
    );
    expect(result).toEqual({
      sandboxId: "sbx-1",
      providerObjectId: "obj-1",
      status: "running",
      createdAt: 1000,
      codeServerUrl: undefined,
      codeServerPassword: undefined,
      ttydUrl: undefined,
      tunnelUrls: undefined,
    });
  });

  it("forwards the multi-repo member list to the client", async () => {
    const client = createMockClient();
    const provider = new GenericSandboxProvider(client);

    const repositories = [
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      { repoOwner: "acme/team", repoName: "api", baseBranch: "develop" },
    ];
    await provider.createSandbox({ ...baseCreateConfig, repositories });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ repositories }),
      undefined
    );
  });

  it("classifies an API error by HTTP status", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new GenericSandboxApiError("boom", 503);
      }),
    });
    const provider = new GenericSandboxProvider(client);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
  });

  it("classifies a 4xx error as permanent", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new GenericSandboxApiError("bad", 400);
      }),
    });
    const provider = new GenericSandboxProvider(client);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
    });
  });
});

describe("GenericSandboxProvider.resumeSandbox", () => {
  const resumeConfig: ResumeConfig = {
    providerObjectId: "obj-1",
    sessionId: "session-1",
    sandboxId: "sbx-1",
  };

  it("returns success with the provider object id", async () => {
    const provider = new GenericSandboxProvider(createMockClient());
    const result = await provider.resumeSandbox!(resumeConfig);
    expect(result).toMatchObject({ success: true, providerObjectId: "obj-1" });
  });

  it("propagates shouldSpawnFresh on failure", async () => {
    const client = createMockClient({
      resumeSandbox: vi.fn(async () => ({
        success: false,
        error: "gone",
        shouldSpawnFresh: true,
      })),
    });
    const provider = new GenericSandboxProvider(client);
    const result = await provider.resumeSandbox!(resumeConfig);
    expect(result).toEqual({ success: false, error: "gone", shouldSpawnFresh: true });
  });
});

describe("GenericSandboxProvider.stopSandbox", () => {
  const stopConfig: StopConfig = {
    providerObjectId: "obj-1",
    sessionId: "session-1",
    reason: "inactivity_timeout",
  };

  it("returns success", async () => {
    const provider = new GenericSandboxProvider(createMockClient());
    expect(await provider.stopSandbox!(stopConfig)).toEqual({ success: true });
  });

  it("surfaces an error result", async () => {
    const client = createMockClient({
      stopSandbox: vi.fn(async () => ({ success: false, error: "nope" })),
    });
    const provider = new GenericSandboxProvider(client);
    expect(await provider.stopSandbox!(stopConfig)).toEqual({ success: false, error: "nope" });
  });
});

describe("GenericSandboxProvider snapshot/restore", () => {
  it("takes a snapshot when enabled", async () => {
    const provider = new GenericSandboxProvider(createMockClient(), { supportsSnapshots: true });
    const result = await provider.takeSnapshot!({
      providerObjectId: "obj-1",
      sessionId: "session-1",
      reason: "execution_complete",
    });
    expect(result).toEqual({ success: true, imageId: "img-1" });
  });

  it("preserves a SandboxProviderError without reclassifying", async () => {
    const client = createMockClient({
      snapshotSandbox: vi.fn(async () => {
        throw new SandboxProviderError("already classified", "transient");
      }),
    });
    const provider = new GenericSandboxProvider(client, { supportsSnapshots: true });
    await expect(
      provider.takeSnapshot!({ providerObjectId: "obj-1", sessionId: "s", reason: "r" })
    ).rejects.toMatchObject({ message: "already classified", errorType: "transient" });
  });
});
