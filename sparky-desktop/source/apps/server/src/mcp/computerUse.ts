import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema } from "effect/unstable/ai";

import * as McpServer from "effect/unstable/ai/McpServer";

type DriverToolResult = {
  readonly text: string;
  readonly images: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }>;
  readonly structuredJson?: string;
  readonly isError: boolean;
  readonly rawJson: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exposeDriverTools = Effect.fn("ComputerUse.exposeDriverTools")(function* () {
  if (process.env.T3CODE_MODE !== "desktop") return;

  const server = yield* McpServer.McpServer;
  const { CuaDriver } = yield* Effect.tryPromise({
    try: () => import("@trycua/cua-driver"),
    catch: (cause) => cause,
  });
  const driver = CuaDriver.create(undefined);
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await driver.shutdown();
      if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function") {
        driver.uniffiDestroy();
      }
    }),
  );

  const rawInventory = yield* Effect.tryPromise({
    try: () => driver.listToolsJson(),
    catch: (cause) => cause,
  });
  const parsedInventory: unknown = JSON.parse(rawInventory);
  const entries = Array.isArray(parsedInventory)
    ? parsedInventory
    : isRecord(parsedInventory) && Array.isArray(parsedInventory.tools)
      ? parsedInventory.tools
      : [];

  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const sourceName = entry.name;
    const publicName = `computer-use-${sourceName.replace(/^cua[_-]?/iu, "").replaceAll("_", "-")}`;
    const description =
      typeof entry.description === "string"
        ? entry.description
        : `Use the computer ${sourceName.replaceAll("_", " ")}.`;
    const inputSchema = (entry.inputSchema ?? entry.input_schema ?? {
      type: "object",
      properties: {},
    }) as McpSchema.Tool["inputSchema"];

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: publicName,
        description,
        inputSchema,
        annotations: {
          title: `Computer use: ${sourceName.replace(/^cua[_-]?/iu, "").replaceAll("_", " ")}`,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      }),
      handle: (payload) =>
        Effect.tryPromise({
          try: () => driver.callTool(sourceName, JSON.stringify(payload)),
          catch: (cause) => cause,
        }).pipe(
          Effect.map((result) => {
            const toolResult = result as DriverToolResult;
            let structuredContent: Record<string, unknown> | undefined;
            if (toolResult.structuredJson) {
              const structured: unknown = JSON.parse(toolResult.structuredJson);
              if (isRecord(structured)) structuredContent = structured;
            }
            const text = toolResult.text || (toolResult.images.length === 0 ? toolResult.rawJson : "");
            return new McpSchema.CallToolResult({
              isError: toolResult.isError,
              ...(structuredContent ? { structuredContent } : {}),
              content: [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...toolResult.images.map((image) => ({
                  type: "image" as const,
                  data: new Uint8Array(Buffer.from(image.dataBase64, "base64")),
                  mimeType: image.mimeType,
                })),
              ],
            });
          }),
          Effect.catch((cause) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: cause instanceof Error ? cause.message : String(cause),
                  },
                ],
              }),
            ),
          ),
        ),
    });
  }
});

export const ComputerUseToolkitRegistrationLive = Layer.effectDiscard(
  exposeDriverTools().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Computer use is unavailable in this desktop session", {
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  ),
);
