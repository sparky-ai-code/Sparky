import { describe, expect, it } from "@effect/vitest";

import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@sparky/contracts";
import {
  modelSelectionsMatch,
  resolveModelSelectionForProviders,
  resolveProjectTarget,
} from "./handlers.ts";

const project = (id: string, title: string) => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `C:/work/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const provider = (input: {
  readonly instanceId: string;
  readonly auth: "authenticated" | "unauthenticated";
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly contextWindowSource?: "oauth" | "provider";
    readonly isDefault?: boolean;
  }>;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make("sparky"),
  displayName: input.instanceId,
  enabled: true,
  installed: true,
  version: "1.1.13",
  status: "ready",
  auth: {
    status: input.auth,
    type: input.auth === "authenticated" ? "oauth" : "apiKey",
  },
  checkedAt: "2026-09-06T00:00:00.000Z",
  availability: "available",
  models: input.models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    capabilities: null,
    ...(model.contextWindowSource ? { contextWindowSource: model.contextWindowSource } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
  })),
  slashCommands: [],
  skills: [],
});

describe("cross-project MCP project targeting", () => {
  it("resolves an exact project id and rejects mismatched titles", () => {
    const projects = [project("one", "One"), project("two", "Two")];
    expect(resolveProjectTarget(projects, { projectId: "one" })).toEqual({ project: projects[0] });
    expect(resolveProjectTarget(projects, { projectId: "one", projectTitle: "Two" })).toMatchObject(
      {
        error: { status: "error", data: { code: "project_target_mismatch" } },
      },
    );
  });

  it("does not guess when a title is ambiguous", () => {
    const projects = [project("one", "Workspace"), project("two", "Workspace")];
    expect(resolveProjectTarget(projects, { projectTitle: "workspace" })).toMatchObject({
      error: { status: "error", data: { code: "ambiguous_project" } },
    });
  });
});

describe("cross-project model routing", () => {
  const oauthProvider = provider({
    instanceId: "sparky",
    auth: "authenticated",
    models: [{ slug: "openai-codex/gpt-5.6-sol", contextWindowSource: "oauth", isDefault: true }],
  });
  const apiKeyProvider = provider({
    instanceId: "api-key",
    auth: "authenticated",
    models: [{ slug: "openai/gpt-4o-mini", contextWindowSource: "provider", isDefault: true }],
  });

  it("inherits the source thread OAuth selection instead of a target project's API-key default", () => {
    const resolved = resolveModelSelectionForProviders([apiKeyProvider, oauthProvider], {
      inherited: {
        instanceId: ProviderInstanceId.make("sparky"),
        model: "openai-codex/gpt-5.6-sol",
      },
    });

    expect(resolved).toMatchObject({
      selection: {
        instanceId: ProviderInstanceId.make("sparky"),
        model: "openai-codex/gpt-5.6-sol",
        contextWindowSource: "oauth",
      },
    });
  });

  it("honors an explicit provider/model selection and rejects an unauthenticated connection", () => {
    const resolved = resolveModelSelectionForProviders([apiKeyProvider, oauthProvider], {
      inherited: {
        instanceId: ProviderInstanceId.make("sparky"),
        model: "openai-codex/gpt-5.6-sol",
      },
      providerInstanceId: "api-key",
      model: "openai/gpt-4o-mini",
    });
    expect(resolved).toMatchObject({
      selection: { instanceId: ProviderInstanceId.make("api-key"), model: "openai/gpt-4o-mini" },
    });

    const unauthenticated = resolveModelSelectionForProviders(
      [
        provider({
          instanceId: "missing-key",
          auth: "unauthenticated",
          models: [{ slug: "openai/gpt-4o-mini" }],
        }),
      ],
      { providerInstanceId: "missing-key", model: "openai/gpt-4o-mini" },
    );
    expect(unauthenticated).toMatchObject({
      error: { data: { code: "provider_not_authenticated" } },
    });
  });

  it("requires the persisted selection to match provider, model, context, and options", () => {
    const expected = {
      instanceId: ProviderInstanceId.make("sparky"),
      model: "openai-codex/gpt-5.6-sol",
      contextWindowSource: "oauth" as const,
      options: [{ id: "reasoningEffort", value: "high" as const }],
    };

    expect(modelSelectionsMatch(expected, { ...expected })).toBe(true);
    expect(
      modelSelectionsMatch(expected, {
        ...expected,
        instanceId: ProviderInstanceId.make("opencode"),
      }),
    ).toBe(false);
    expect(
      modelSelectionsMatch(expected, { ...expected, model: "opencode/deepseek-v4-flash-free" }),
    ).toBe(false);
    expect(modelSelectionsMatch(expected, { ...expected, contextWindowSource: "provider" })).toBe(
      false,
    );
    expect(
      modelSelectionsMatch(expected, {
        ...expected,
        options: [{ id: "reasoningEffort", value: "low" as const }],
      }),
    ).toBe(false);
  });
});
