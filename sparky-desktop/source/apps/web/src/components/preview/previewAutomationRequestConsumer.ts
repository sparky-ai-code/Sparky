import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@sparky/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  PreviewAutomationOperationError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;

const MAX_HANDLED_REQUESTS = 1024;

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
  }>;
  /** Shared by successive consumer mounts for the same desktop automation host. */
  readonly processedRequestIds?: Set<string>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  // Replayable AsyncResult subscriptions may deliver one request repeatedly.
  // Record it before invoking the handler, including while the first is pending.
  const processedRequestIds = options.processedRequestIds ?? new Set<string>();
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        return;
      }
      const request = event.request;
      const key = `${event.connectionId}\u0000${request.requestId}`;
      if (processedRequestIds.has(key)) return;
      processedRequestIds.add(key);
      if (processedRequestIds.size > MAX_HANDLED_REQUESTS) {
        const oldest = processedRequestIds.values().next().value;
        if (oldest !== undefined) processedRequestIds.delete(oldest);
      }
      void get
        .once(options.requestHandlerAtom)
        .handle(request)
        .then(
          (value) =>
            options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: true,
              ...(value === undefined ? {} : { result: value }),
            }),
          (error) =>
            options.respond({
              clientId: options.clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: serializePreviewAutomationError(error, {
                requestId: request.requestId,
                operation: request.operation,
                environmentId: options.environmentId,
                threadId: request.threadId,
                tabId: request.tabId ?? null,
              }),
            }),
        );
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
