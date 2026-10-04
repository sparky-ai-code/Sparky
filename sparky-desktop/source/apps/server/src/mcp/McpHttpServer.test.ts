import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@sparky/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("reviews a PR with the separate review agent before posting validated findings", () => {
  const headSha = "a".repeat(40);
  const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
  const pullRequestMetadata = encodeJson({
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    title: "Review target",
    body: "PR description",
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: headSha,
  });
  const postedReviewMetadata = encodeJson({
    html_url: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
  });
  const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1 @@
+const value = 1;
`;
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const reviewCalls: Array<
    Parameters<GitWorkflowService.GitWorkflowService["Service"]["reviewPullRequest"]>[0]
  > = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        const stdout =
          input.args[0] === "pr" && input.args[1] === "view"
            ? pullRequestMetadata
            : input.args[0] === "pr" && input.args[1] === "diff"
              ? diff
              : postedReviewMetadata;
        return {
          stdout,
          stderr: "",
          code: 0 as NonNullable<ProcessRunner.ProcessRunOutput["code"]>,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const gitWorkflowLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    reviewPullRequest: (input) =>
      Effect.sync(() => {
        reviewCalls.push(input);
        return {
          response: encodeJson({
            summary: "One issue found.",
            findings: [
              {
                path: "src/example.ts",
                line: 1,
                severity: "high",
                title: "Guard the value",
                body: "The upstream value can be empty.",
              },
            ],
          }),
        };
      }),
  });
  const reviewLayer = McpHttpServer.PullRequestReviewToolkitRegistrationLive.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
    Layer.provideMerge(gitWorkflowLayer),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "review_pull_request",
          arguments: { repository: "owner/repo", number: 7 },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation,
            cwd: "C:/workspace",
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ submittedComments: 1, skippedComments: 0 });
      expect(reviewCalls).toHaveLength(1);
      expect(reviewCalls[0]?.cwd).toBe("C:/workspace");
      expect(reviewCalls[0]?.prompt).toContain("diff --git a/src/example.ts b/src/example.ts");
      expect(reviewCalls[0]?.prompt).toContain("const value = 1;");
      expect(reviewCalls[0]?.systemPrompt).toContain("independent, one-shot code review agent");
      const postCall = calls.find((call) => call.args[0] === "api");
      expect(postCall?.command).toBe("gh");
      expect(postCall?.cwd).toBe("C:/workspace");
      const postedReview = yield* decodeUnknownJson(postCall?.stdin ?? "{}");
      expect(postedReview).toMatchObject({
        comments: [
          {
            path: "src/example.ts",
            line: 1,
            side: "RIGHT",
            body: "**HIGH: Guard the value**\n\nThe upstream value can be empty.",
          },
        ],
      });
    }).pipe(Effect.provide(reviewLayer)),
  );
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
