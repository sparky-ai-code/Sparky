import { it as effectIt } from "@effect/vitest";
import { EnvironmentId } from "@sparky/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("shares a persistent browser profile across environments", () => {
    const getBrowserSession = vi.fn(() => Effect.succeed(null as never));
    const getBrowserPartition = vi.fn(() =>
      Effect.succeed("persist:t3code-preview-default"),
    );

    return Effect.gen(function* () {
      const first = yield* PreviewIpc.getPreviewConfig.handler({
        environmentId: EnvironmentId.make("environment-a"),
      });
      const second = yield* PreviewIpc.getPreviewConfig.handler({
        environmentId: EnvironmentId.make("environment-b"),
      });

      expect(first.partition).toBe(second.partition);
      expect(first.partition.startsWith("persist:")).toBe(true);
      // Neither environment should become part of the browser session key.
      expect(getBrowserSession.mock.calls).toEqual([[], []]);
      expect(getBrowserPartition.mock.calls).toEqual([[], []]);
    }).pipe(
      Effect.provide(
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession,
          getBrowserPartition,
        }),
      ),
    );
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );
});
