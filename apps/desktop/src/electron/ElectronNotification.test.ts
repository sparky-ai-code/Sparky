import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { isSupportedMock, notificationConstructorMock, showMock } = vi.hoisted(() => {
  const showMock = vi.fn();
  const notificationConstructorMock = vi.fn(function NotificationMock() {
    return { show: showMock };
  });
  return {
    isSupportedMock: vi.fn(() => true),
    notificationConstructorMock,
    showMock,
  };
});

vi.mock("electron", () => ({
  Notification: Object.assign(notificationConstructorMock, { isSupported: isSupportedMock }),
}));

import * as ElectronNotification from "./ElectronNotification.ts";

describe("ElectronNotification", () => {
  beforeEach(() => {
    isSupportedMock.mockReset();
    isSupportedMock.mockReturnValue(true);
    notificationConstructorMock.mockClear();
    showMock.mockClear();
  });

  it.effect("shows supported native notifications", () =>
    Effect.gen(function* () {
      yield* ElectronNotification.make.show({ title: "Sparky", body: "Hello! How can I help?" });

      assert.deepEqual(notificationConstructorMock.mock.calls, [
        [{ title: "Sparky", body: "Hello! How can I help?" }],
      ]);
      assert.isTrue(showMock.mock.calls.length === 1);
    }),
  );

  it.effect("does nothing when native notifications are unavailable", () => {
    isSupportedMock.mockReturnValue(false);
    return Effect.gen(function* () {
      yield* ElectronNotification.make.show({ title: "Sparky", body: "Hello! How can I help?" });

      assert.isTrue(notificationConstructorMock.mock.calls.length === 0);
      assert.isTrue(showMock.mock.calls.length === 0);
    });
  });
});
