import { createHashHistory } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";

import { DEMO_ENVIRONMENT_ID, DEMO_INITIAL_THREAD_ID, seedDemoDatabase } from "./demoSeed";

async function mountRenderer(root: HTMLElement) {
  await seedDemoDatabase();
  const expectedHash = `#/${DEMO_ENVIRONMENT_ID}/${DEMO_INITIAL_THREAD_ID}`;
  if (!window.location.hash.startsWith(`#/${DEMO_ENVIRONMENT_ID}/`)) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${expectedHash}`,
    );
  }
  const [{ AppRoot }, { getRouter }] = await Promise.all([
    import("../AppRoot"),
    import("../router"),
  ]);
  const router = getRouter(createHashHistory());
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppRoot router={router} />
    </React.StrictMode>,
  );
}

export async function mountDemo() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing demo root element.");
  await mountRenderer(root);
}
