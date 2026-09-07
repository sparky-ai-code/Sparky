// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
} from "@sparky/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeSparkyAssistantSegmenter,
  makeSparkyProcessArgs,
  makeSparkyStreamDecoder,
  normalizeSparkyContextWindow,
  parseSparkyContextWindowTokens,
  parseSparkyModelSelection,
  formatSparkyProcessError,
  resolveSparkyRuntimeContextWindow,
  captureSparkySessionIdentity,
  isRetryableSparkyProcessError,
  readSparkySessionBinding,
  resolveSparkySessionId,
  sparkyToolPresentation,
  isHiddenSparkyControlTool,
  writeSparkySessionBinding,
} from "./SparkyAdapter.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";

describe("hidden Sparky control tools", () => {
  it("suppresses only the terminal control tool from UI lifecycle rendering", () => {
    expect(isHiddenSparkyControlTool("end_task")).toBe(true);
    expect(isHiddenSparkyControlTool("update_plan")).toBe(false);
    expect(isHiddenSparkyControlTool("preview_click")).toBe(false);
  });
});

describe("Sparky reconnect classification", () => {
  const processError = (detail: string) =>
    new ProviderAdapterProcessError({
      provider: "sparky",
      threadId: "thread-1",
      detail,
    });

  it("retries network and stalled-process failures", () => {
    expect(isRetryableSparkyProcessError(processError("Sparky turn stalled after 600000ms"))).toBe(
      true,
    );
    expect(
      isRetryableSparkyProcessError(processError("ECONNRESET while contacting provider")),
    ).toBe(true);
    expect(
      isRetryableSparkyProcessError(
        processError(
          "Unable to reach ChatGPT Codex after 2 attempt(s): error sending request for url",
        ),
      ),
    ).toBe(true);
  });

  it("does not retry permanent request or authentication failures", () => {
    expect(
      isRetryableSparkyProcessError(processError("Unsupported parameter: max_output_tokens")),
    ).toBe(false);
    expect(isRetryableSparkyProcessError(processError("401 Unauthorized"))).toBe(false);
  });

  it("does not retry an exhausted provider free-tier quota", () => {
    expect(
      isRetryableSparkyProcessError(
        processError(
          'OpenCode API error (HTTP 429 Too Many Requests): {"type":"FreeUsageLimitError","message":"Rate limit exceeded."}',
        ),
      ),
    ).toBe(false);
  });
});

describe("makeSparkyStreamDecoder", () => {
  it("allows the result callback to finish the decoder synchronously", () => {
    let finished: unknown;
    let decoder: ReturnType<typeof makeSparkyStreamDecoder>;
    decoder = makeSparkyStreamDecoder({
      onResult: () => {
        finished = decoder.finish();
      },
    });

    decoder.push('{"type":"result","response":"Done"}\n');

    expect(finished).toEqual({ response: "Done" });
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("signals protocol completion immediately when the terminal result frame arrives", () => {
    const results: unknown[] = [];
    const decoder = makeSparkyStreamDecoder({
      onResult: (result) => results.push(result),
    });

    decoder.push('{"type":"result","response":"Done","sessionId":"session-1"}\n');

    expect(results).toEqual([{ response: "Done", sessionId: "session-1" }]);
    expect(decoder.finish()).toEqual({ response: "Done", sessionId: "session-1" });
  });

  it("captures a durable session identity before a one-shot turn completes", () => {
    const sessionIds: string[] = [];
    const decoder = makeSparkyStreamDecoder({
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    decoder.push('{"type":"session","sessionId":"session-1"}\n');
    decoder.push('{"type":"result","response":"Done","sessionId":"session-1"}\n');

    expect(sessionIds).toEqual(["session-1"]);
    expect(decoder.finish()).toEqual({ response: "Done", sessionId: "session-1" });
  });

  it("emits token deltas before the final process result across split stdout chunks", () => {
    const deltas: string[] = [];
    const decoder = makeSparkyStreamDecoder({ onDelta: (delta) => deltas.push(delta) });

    decoder.push('{"type":"delta","del');
    expect(deltas).toEqual([]);

    decoder.push('ta":"Hel"}\n{"type":"delta","delta":"lo"}\n');
    expect(deltas).toEqual(["Hel", "lo"]);

    decoder.push('{"type":"result","response":"Hello","sessionId":"session-1"}');
    expect(decoder.finish()).toEqual({ response: "Hello", sessionId: "session-1" });
  });

  it("streams tool lifecycle events before the final result across split stdout chunks", () => {
    const events: Array<{ readonly type: string; readonly value: unknown }> = [];
    const decoder = makeSparkyStreamDecoder({
      onToolStarted: (value) => events.push({ type: "started", value }),
      onToolCompleted: (value) => events.push({ type: "completed", value }),
    });

    decoder.push('{"type":"tool.started","toolCallId":"call-1","toolName":"read","arg');
    expect(events).toEqual([]);

    decoder.push(
      'uments":{"path":"README.md"}}\n' +
        '{"type":"tool.completed","toolCallId":"call-1","toolName":"read",' +
        '"output":"hello","isError":false}\n',
    );

    expect(events).toEqual([
      {
        type: "started",
        value: {
          toolCallId: "call-1",
          toolName: "read",
          arguments: { path: "README.md" },
        },
      },
      {
        type: "completed",
        value: {
          toolCallId: "call-1",
          toolName: "read",
          output: "hello",
          isError: false,
        },
      },
    ]);

    decoder.push('{"type":"result","response":"Done"}\n');
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("exposes an open tool lifecycle so process inactivity does not kill active work", () => {
    const decoder = makeSparkyStreamDecoder();

    expect(decoder.hasOpenTools()).toBe(false);
    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"bash","arguments":{}}\n',
    );
    expect(decoder.hasOpenTools()).toBe(true);
    decoder.push(
      '{"type":"tool.completed","toolCallId":"call-1","toolName":"bash",' +
        '"output":"done","isError":false}\n',
    );
    expect(decoder.hasOpenTools()).toBe(false);
    decoder.push('{"type":"result","response":"Done"}\n');
    expect(decoder.finish()).toEqual({ response: "Done" });
  });

  it("forwards real token usage events to the desktop context meter", () => {
    const usage: unknown[] = [];
    const decoder = makeSparkyStreamDecoder({ onUsage: (value) => usage.push(value) });
    decoder.push(
      '{"type":"usage","promptTokens":1200,"completionTokens":80,' +
        '"totalTokens":1280,"cumulativeTotalTokens":2400}\n' +
        '{"type":"result","response":"Done"}\n',
    );

    expect(decoder.finish()).toEqual({ response: "Done" });
    expect(usage).toEqual([
      {
        promptTokens: 1200,
        completionTokens: 80,
        totalTokens: 1280,
        cumulativeTotalTokens: 2400,
      },
    ]);
  });

  it("rejects malformed protocol events instead of silently buffering forever", () => {
    const decoder = makeSparkyStreamDecoder();
    decoder.push("not-json\n");
    expect(() => decoder.finish()).toThrow("invalid streaming event");
  });

  it("rejects an early EOF that never delivered a terminal result", () => {
    const decoder = makeSparkyStreamDecoder();
    decoder.push('{"type":"delta","delta":"partial"}\n');

    expect(() => decoder.finish()).toThrow("empty streaming result");
  });

  it("does not complete a turn while a tool lifecycle is still open", () => {
    const completed: unknown[] = [];
    const decoder = makeSparkyStreamDecoder({
      onToolCompleted: (event) => completed.push(event),
    });

    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"read","arguments":{}}\n' +
        '{"type":"result","response":"Done"}\n',
    );

    expect(() => decoder.finish()).toThrow("before this tool returned a result");
    expect(completed).toEqual([
      {
        toolCallId: "call-1",
        toolName: "read",
        output: "Sparky ended before this tool returned a result.",
        isError: true,
      },
    ]);
  });

  it("rejects malformed and unknown protocol frames instead of ignoring them", () => {
    const malformed = makeSparkyStreamDecoder();
    malformed.push('{"type":"tool.started","toolCallId":"call-1"}\n');
    expect(() => malformed.finish()).toThrow("malformed tool.started event");

    const unknown = makeSparkyStreamDecoder();
    unknown.push('{"type":"provider.warning","message":"unexpected"}\n');
    expect(() => unknown.finish()).toThrow("unknown streaming event");
  });

  it("fails a tool lifecycle when the child ends before sending its completion", () => {
    const completed: unknown[] = [];
    const decoder = makeSparkyStreamDecoder({
      onToolCompleted: (event) => completed.push(event),
    });

    decoder.push(
      '{"type":"tool.started","toolCallId":"call-1","toolName":"update_plan","arguments":{}}\n',
    );
    decoder.failOpenTools("Sparky process stopped.");

    expect(completed).toEqual([
      {
        toolCallId: "call-1",
        toolName: "update_plan",
        output: "Sparky process stopped.",
        isError: true,
      },
    ]);
  });
});

describe("sparkyToolPresentation", () => {
  it("gives browser MCP tools readable titles and an MCP lifecycle type", () => {
    expect(sparkyToolPresentation("preview_evaluate", { expression: "document.title" })).toEqual({
      itemType: "mcp_tool_call",
      title: "Evaluate browser JavaScript",
      data: {
        kind: "preview_evaluate",
        toolName: "preview_evaluate",
        rawInput: { expression: "document.title" },
      },
    });
  });

  it("preserves a dedicated lifecycle type for web search", () => {
    expect(sparkyToolPresentation("web_search", { query: "Rust serde" })).toMatchObject({
      itemType: "web_search",
      title: "Search the web",
      data: { toolName: "web_search", rawInput: { query: "Rust serde" } },
    });
  });

  it("humanizes memory tool names while preserving their wire names", () => {
    expect(sparkyToolPresentation("memory_search", { query: "preferences" })).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Search memory",
      data: { toolName: "memory_search" },
    });
  });

  it("preserves plugin identity in the lifecycle payload", () => {
    expect(
      sparkyToolPresentation("sparky_plugin_call", {
        pluginId: "GMAIL",
        action: "search_messages",
        input: {},
      }),
    ).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Sparky Plugin Call",
      data: {
        pluginId: "gmail",
        rawInput: { pluginId: "GMAIL", action: "search_messages", input: {} },
      },
    });
  });

  it("humanizes built-in planning tool names", () => {
    expect(sparkyToolPresentation("update_plan", {})).toMatchObject({
      itemType: "dynamic_tool_call",
      title: "Update plan",
    });
  });

  it("uses readable titles for cross-project thread tools", () => {
    expect(sparkyToolPresentation("sparky_list_projects", {})).toMatchObject({
      title: "List projects",
    });
    expect(sparkyToolPresentation("sparky_list_threads", {})).toMatchObject({
      title: "List threads",
    });
    expect(sparkyToolPresentation("sparky_list_models", {})).toMatchObject({
      title: "List models",
    });
    expect(sparkyToolPresentation("sparky_set_model", {})).toMatchObject({
      title: "Set model",
    });
    expect(sparkyToolPresentation("sparky_create_thread", {})).toMatchObject({
      title: "Create thread",
    });
    expect(sparkyToolPresentation("sparky_send_message", {})).toMatchObject({
      title: "Send thread message",
    });
  });
});

describe("makeSparkyAssistantSegmenter", () => {
  it("closes narration before a tool and starts a fresh block when text resumes", () => {
    const events: string[] = [];
    let nextId = 0;
    const segments = makeSparkyAssistantSegmenter(
      {
        onStarted: (id) => events.push(`start:${id}`),
        onDelta: (id, delta) => events.push(`delta:${id}:${delta}`),
        onCompleted: (id, text) => events.push(`complete:${id}:${text}`),
      },
      () => `assistant-${++nextId}`,
    );

    segments.pushDelta("Let me check. ");
    segments.pushDelta("One moment.");
    segments.closeBeforeTool();
    events.push("tool");
    segments.pushDelta("The file is ready.");
    segments.finish("Let me check. One moment.The file is ready.");

    expect(events).toEqual([
      "start:assistant-1",
      "delta:assistant-1:Let me check. ",
      "delta:assistant-1:One moment.",
      "complete:assistant-1:Let me check. One moment.",
      "tool",
      "start:assistant-2",
      "delta:assistant-2:The file is ready.",
      "complete:assistant-2:The file is ready.",
    ]);
  });

  it("uses the final response only when no text delta was emitted", () => {
    const events: string[] = [];
    const segments = makeSparkyAssistantSegmenter(
      {
        onStarted: (id) => events.push(`start:${id}`),
        onDelta: (id, delta) => events.push(`delta:${id}:${delta}`),
        onCompleted: (id, text) => events.push(`complete:${id}:${text}`),
      },
      () => "assistant-fallback",
    );

    segments.finish("Fallback response");

    expect(events).toEqual([
      "start:assistant-fallback",
      "delta:assistant-fallback:Fallback response",
      "complete:assistant-fallback:Fallback response",
    ]);
  });
});

describe("Sparky session continuity", () => {
  it("routes the OpenCode Zen model slug to its provider and base URL", () => {
    expect(parseSparkyModelSelection("opencode/deepseek-v4-flash-free")).toEqual({
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("passes OpenCode through the OpenCode provider path", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Use OpenCode",
      model: "opencode/deepseek-v4-flash-free",
    });

    expect(args.at(args.indexOf("--provider") + 1)).toBe("opencode");
    expect(args.at(args.indexOf("--base-url") + 1)).toBe("https://opencode.ai/zen/v1");
  });

  it("routes OAuth Codex models through Codex instead of the API-key OpenAI path", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Use the connected OAuth account",
      model: "openai-codex/gpt-5.6-sol",
    });

    expect(args.at(args.indexOf("--provider") + 1)).toBe("openai-codex");
    expect(args.at(args.indexOf("--provider") + 1)).not.toBe("openai");
  });

  it("refuses to infer a provider for an unqualified model selection", () => {
    expect(() => parseSparkyModelSelection("GPT-6 Astra")).toThrow(
      "must use an explicit provider/model slug",
    );
    expect(() => parseSparkyModelSelection(undefined)).toThrow(
      "missing an explicit provider/model slug",
    );
  });

  it("explains when a project-free turn is using an outdated Sparky binary", () => {
    expect(
      formatSparkyProcessError("error: unexpected argument '--no-workspace-context' found", "none"),
    ).toBe(
      "The configured Sparky runtime is outdated and does not support project-free chats. Rebuild or update the Sparky binary, then retry.",
    );
    expect(
      formatSparkyProcessError(
        "error: unexpected argument '--no-workspace-context' found",
        "project",
      ),
    ).toContain("unexpected argument");
  });

  it("explains when a provider free-tier quota is exhausted", () => {
    expect(
      formatSparkyProcessError(
        'OpenCode API error (HTTP 429): {"type":"FreeUsageLimitError","message":"Rate limit exceeded."}',
        "none",
      ),
    ).toBe(
      "OpenCode Zen reported that this model's free usage limit was reached. Select another model or try again later.",
    );
  });

  it("uses the provider-native text-only path for metadata generation", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Name this thread",
      model: "openai-codex/gpt-5.6-sol",
      textOnly: true,
    });

    expect(args).toContain("--text-only");
    expect(args).not.toContain("--session");
  });

  it("disables workspace context for project-free runtime turns", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\project-free-runtime",
      prompt: "Answer without project context",
      model: "openai/gpt-4o",
      textOnly: true,
      workspaceContext: "none",
    });

    expect(args).toContain("--text-only");
    expect(args).toContain("--no-workspace-context");
  });

  it("passes saved custom instructions into the Sparky runtime", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Create the feature",
      model: "openai/gpt-4o",
      customInstructions: "Prefer TypeScript and explain risky changes.",
    });

    expect(args).toContain("--append-system-prompt");
    expect(args.at(args.indexOf("--append-system-prompt") + 1)).toBe(
      "Prefer TypeScript and explain risky changes.",
    );
  });

  it("passes the desktop MCP endpoint without putting its bearer token on the command line", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Test the page",
      model: "opencode/deepseek-v4-flash-free",
      mcpUrl: "http://127.0.0.1:43123/mcp",
      mcpBearerTokenEnvVar: "T3_MCP_BEARER_TOKEN",
    });

    expect(args.at(args.indexOf("--mcp-url") + 1)).toBe("http://127.0.0.1:43123/mcp");
    expect(args.at(args.indexOf("--mcp-bearer-token-env-var") + 1)).toBe("T3_MCP_BEARER_TOKEN");
    expect(args.join(" ")).not.toContain("Bearer ");
  });

  it("sends only the new follow-up while resuming the exact existing session", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Now make it green",
      model: "openai/gpt-4o",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(args).toContain("--session");
    expect(args.at(args.indexOf("--session") + 1)).toBe("11111111-1111-4111-8111-111111111111");
    expect(args).toContain("--prompt-stdin");
    expect(args).not.toContain("Now make it green");
    expect(args.join(" ")).not.toContain("Continue this coding conversation");
  });

  it("keeps long prompts off the Windows command line and forwards reasoning effort", () => {
    const prompt = "x".repeat(100_000);
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt,
      model: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    expect(args).toContain("--prompt-stdin");
    expect(args).not.toContain(prompt);
    expect(args.at(args.indexOf("--effort") + 1)).toBe("xhigh");
  });

  it("forwards provider-selected context windows and Plan mode", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Plan the migration",
      model: "opencode/zen-test",
      contextWindow: "200k",
      interactionMode: "plan",
    });

    expect(args.at(args.indexOf("--context-window") + 1)).toBe("200k");
    expect(args.at(args.indexOf("--interaction-mode") + 1)).toBe("plan");
    expect(parseSparkyContextWindowTokens("200k")).toBe(200_000);
    expect(parseSparkyContextWindowTokens("unsupported")).toBeUndefined();
  });

  it("caps only the OAuth Codex context window", () => {
    const environment = { SPARKY_CODEX_HOME: "C:\\sparky-test-codex-home-that-does-not-exist" };
    expect(normalizeSparkyContextWindow("openai-codex/gpt-5.6-sol", "1m", environment)).toBe(
      "258400",
    );
    expect(normalizeSparkyContextWindow("openai/gpt-5.6-sol", "1m", environment)).toBe("1m");
    expect(normalizeSparkyContextWindow("openai-codex/gpt-5.6-sol", "128k", environment)).toBe(
      "128k",
    );
  });

  it("does not pass an unverified Models.dev context window to the runtime", () => {
    const environment = { SPARKY_CODEX_HOME: "C:\\sparky-test-codex-home-that-does-not-exist" };
    expect(
      resolveSparkyRuntimeContextWindow(
        "openai-codex/gpt-5.6-sol",
        {
          instanceId: ProviderInstanceId.make("sparky"),
          model: "openai-codex/gpt-5.6-sol",
          contextWindowSource: "models.dev",
          options: [{ id: "contextWindow", value: "1m" }],
        },
        environment,
      ),
    ).toBe("258400");
    expect(
      resolveSparkyRuntimeContextWindow("openai-codex/gpt-5.6-sol", {
        instanceId: ProviderInstanceId.make("sparky"),
        model: "openai-codex/gpt-5.6-sol",
        contextWindowSource: "provider",
        options: [{ id: "contextWindow", value: "258400" }],
      }),
    ).toBe("258400");
  });

  it("maps the provider default mode to Sparky's build mode", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Add the feature",
      model: "opencode/zen-test",
      interactionMode: "default",
    });

    expect(args.at(args.indexOf("--interaction-mode") + 1)).toBe("build");
  });

  it("passes persisted image files and MIME types to the Rust runtime", () => {
    const args = makeSparkyProcessArgs({
      cwd: "C:\\workspace",
      prompt: "Describe this image",
      model: "openai-codex/gpt-5.6-sol",
      images: [{ path: "C:\\state\\attachments\\image.png", mimeType: "image/png" }],
    });

    expect(args.at(args.indexOf("--image-path") + 1)).toBe("C:\\state\\attachments\\image.png");
    expect(args.at(args.indexOf("--image-mime-type") + 1)).toBe("image/png");
  });

  it("persists the early session identity so an interrupted turn keeps its chat context", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-interrupted-session-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const threadId = ThreadId.make("thread-interrupted");
    const now = "2026-01-01T00:00:00.000Z";
    const state: { session: ProviderSession } = {
      session: {
        provider: ProviderDriverKind.make("sparky"),
        providerInstanceId: ProviderInstanceId.make("sparky"),
        status: "running",
        runtimeMode: "full-access",
        threadId,
        cwd,
        createdAt: now,
        updatedAt: now,
      },
    };
    try {
      const sessionsDirectory = NodePath.join(cwd, ".sparky", "sessions");
      NodeFS.mkdirSync(sessionsDirectory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${sessionId}.jsonl`),
        "session created before provider work\n",
      );

      // The runtime publishes this identity before doing provider work. It must
      // be durable even when interruption prevents a terminal result frame.
      captureSparkySessionIdentity(state, cwd, threadId, sessionId);
      state.session = { ...state.session, status: "ready", activeTurnId: undefined };

      const resumedSessionId = resolveSparkySessionId(
        cwd,
        String(threadId),
        state.session.resumeCursor,
      );
      const args = makeSparkyProcessArgs({
        cwd,
        prompt: "remember the message before I stopped you",
        model: "openai/gpt-4o",
        sessionId: resumedSessionId,
      });

      expect(state.session.resumeCursor).toEqual({
        threadId: String(threadId),
        sparkySessionId: sessionId,
        cwd,
      });
      expect(readSparkySessionBinding(cwd, String(threadId))).toBe(sessionId);
      expect(args.at(args.indexOf("--session") + 1)).toBe(sessionId);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists separate thread bindings and restores them after adapter restart", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-session-binding-"));
    const firstSession = "11111111-1111-4111-8111-111111111111";
    const secondSession = "22222222-2222-4222-8222-222222222222";
    try {
      const sessionsDirectory = NodePath.join(cwd, ".sparky", "sessions");
      NodeFS.mkdirSync(sessionsDirectory, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${firstSession}.jsonl`),
        "session one\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(sessionsDirectory, `${secondSession}.jsonl`),
        "session two\n",
      );

      writeSparkySessionBinding(cwd, "thread-one", firstSession);
      writeSparkySessionBinding(cwd, "thread-two", secondSession);

      expect(NodeFS.readFileSync(NodePath.join(cwd, ".gitignore"), "utf8")).toContain("/.sparky/");
      expect(readSparkySessionBinding(cwd, "thread-one")).toBe(firstSession);
      expect(readSparkySessionBinding(cwd, "thread-two")).toBe(secondSession);
      expect(readSparkySessionBinding(cwd, "thread-three")).toBeUndefined();
      expect(resolveSparkySessionId(cwd, "thread-one", undefined)).toBe(firstSession);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to silently start a new conversation when resume state is missing", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-session-missing-"));
    try {
      expect(() =>
        resolveSparkySessionId(cwd, "thread-one", {
          threadId: "thread-one",
          sparkySessionId: "11111111-1111-4111-8111-111111111111",
        }),
      ).toThrow(/Refusing to start a new conversation/u);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
