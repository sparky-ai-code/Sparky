// Keep recently visited threads warm for quick back-navigation without holding
// entire message/tool histories and subscriptions for five idle minutes.
// Active (subscribed) threads are never evicted by the idle TTL.
export const THREAD_STATE_IDLE_TTL_MS = 90_000;
