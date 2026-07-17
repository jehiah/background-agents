/**
 * Unit tests for GenericSandboxClient.
 *
 * Verifies endpoint paths, bearer auth, wire-format translation, and the
 * `{ success, data, error }` envelope handling against a mocked fetch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenericSandboxApiError,
  GenericSandboxClient,
  createGenericSandboxClient,
} from "./generic-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const config = { baseUrl: "https://sandbox.test/api/", bearerToken: "secret-token" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GenericSandboxClient constructor", () => {
  it("requires a base URL and bearer token", () => {
    expect(() => new GenericSandboxClient({ baseUrl: "", bearerToken: "t" })).toThrow(/baseUrl/);
    expect(() => new GenericSandboxClient({ baseUrl: "https://x", bearerToken: "" })).toThrow(
      /bearerToken/
    );
  });
});

describe("GenericSandboxClient.createSandbox", () => {
  it("posts the protocol wire format with bearer auth and maps the response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          sandbox_id: "sbx-1",
          provider_object_id: "obj-1",
          status: "running",
          created_at: 1234,
          code_server_url: "https://cs.test",
          tunnel_urls: { "3000": "https://t.test" },
        },
      })
    );

    const client = createGenericSandboxClient(config);
    const result = await client.createSandbox({
      sessionId: "session-1",
      sandboxId: "sbx-1",
      repoOwner: "acme",
      repoName: "widgets",
      controlPlaneUrl: "https://cp.test",
      sandboxAuthToken: "auth-token",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    // Trailing slash on baseUrl is stripped; path is appended.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox.test/api/sandbox/create");
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-token");

    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      session_id: "session-1",
      sandbox_id: "sbx-1",
      repo_owner: "acme",
      repo_name: "widgets",
      control_plane_url: "https://cp.test",
      sandbox_auth_token: "auth-token",
    });

    expect(result).toMatchObject({
      sandboxId: "sbx-1",
      providerObjectId: "obj-1",
      status: "running",
      createdAt: 1234,
      codeServerUrl: "https://cs.test",
      tunnelUrls: { "3000": "https://t.test" },
    });
  });

  it("forwards the multi-repo member list as repositories in snake_case", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { sandbox_id: "sbx-1", status: "running", created_at: 1 },
      })
    );

    const client = createGenericSandboxClient(config);
    await client.createSandbox({
      sessionId: "session-1",
      repoOwner: "acme",
      repoName: "web",
      controlPlaneUrl: "https://cp.test",
      sandboxAuthToken: "auth-token",
      repositories: [
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme/team", repoName: "api", baseBranch: "develop" },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.repositories).toEqual([
      { repo_owner: "acme", repo_name: "web", branch: "main" },
      { repo_owner: "acme/team", repo_name: "api", branch: "develop" },
    ]);
  });

  it("sends repositories: null when no member list is supplied", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        success: true,
        data: { sandbox_id: "sbx-1", status: "running", created_at: 1 },
      })
    );

    const client = createGenericSandboxClient(config);
    await client.createSandbox({
      sessionId: "session-1",
      repoOwner: "acme",
      repoName: "web",
      controlPlaneUrl: "https://cp.test",
      sandboxAuthToken: "auth-token",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.repositories).toBeNull();
  });

  it("throws GenericSandboxApiError on a non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const client = createGenericSandboxClient(config);
    await expect(
      client.createSandbox({
        sessionId: "s",
        repoOwner: "a",
        repoName: "b",
        controlPlaneUrl: "https://cp.test",
        sandboxAuthToken: "t",
      })
    ).rejects.toBeInstanceOf(GenericSandboxApiError);
  });

  it("throws when the envelope reports failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: false, error: "quota exceeded" })
    );
    const client = createGenericSandboxClient(config);
    await expect(
      client.createSandbox({
        sessionId: "s",
        repoOwner: "a",
        repoName: "b",
        controlPlaneUrl: "https://cp.test",
        sandboxAuthToken: "t",
      })
    ).rejects.toThrow(/quota exceeded/);
  });
});

describe("GenericSandboxClient envelope operations", () => {
  it("routes the multi-repo member list through session_config on restore", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ success: true, data: { sandbox_id: "sbx-1" } }));

    const client = createGenericSandboxClient(config);
    await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "s",
      sandboxId: "sbx-1",
      sandboxAuthToken: "t",
      controlPlaneUrl: "https://cp.test",
      repoOwner: "acme",
      repoName: "web",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      repositories: [
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme/team", repoName: "api", baseBranch: "develop" },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.session_config.repositories).toEqual([
      { repo_owner: "acme", repo_name: "web", branch: "main" },
      { repo_owner: "acme/team", repo_name: "api", branch: "develop" },
    ]);
  });

  it("returns a failure result (not a throw) when restore reports an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: false, error: "snapshot missing" })
    );
    const client = createGenericSandboxClient(config);
    const result = await client.restoreSandbox({
      snapshotImageId: "img-1",
      sessionId: "s",
      sandboxId: "sbx-1",
      sandboxAuthToken: "t",
      controlPlaneUrl: "https://cp.test",
      repoOwner: "a",
      repoName: "b",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ success: false, error: "snapshot missing" });
  });

  it("maps a successful snapshot to an image id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: true, data: { image_id: "img-9" } })
    );
    const client = createGenericSandboxClient(config);
    const result = await client.snapshotSandbox({
      providerObjectId: "obj-1",
      sessionId: "s",
      reason: "execution_complete",
    });
    expect(result).toEqual({ success: true, imageId: "img-9" });
  });

  it("reports missing image_id as a snapshot failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true, data: {} }));
    const client = createGenericSandboxClient(config);
    const result = await client.snapshotSandbox({
      providerObjectId: "obj-1",
      sessionId: "s",
      reason: "r",
    });
    expect(result.success).toBe(false);
  });

  it("propagates should_spawn_fresh on a failed resume", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ success: false, error: "gone", data: { should_spawn_fresh: true } })
    );
    const client = createGenericSandboxClient(config);
    const result = await client.resumeSandbox({
      providerObjectId: "obj-1",
      sessionId: "s",
      sandboxId: "sbx-1",
    });
    expect(result).toMatchObject({ success: false, error: "gone", shouldSpawnFresh: true });
  });

  it("treats a successful stop envelope as success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true }));
    const client = createGenericSandboxClient(config);
    expect(
      await client.stopSandbox({ providerObjectId: "obj-1", sessionId: "s", reason: "r" })
    ).toEqual({
      success: true,
    });
  });
});
