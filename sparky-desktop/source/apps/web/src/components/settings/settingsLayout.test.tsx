import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SettingsRow, SettingsSection } from "./settingsLayout";

describe("SettingsSection About rows", () => {
  it("renders the update-track row while keeping Diagnostics hidden", () => {
    const html = renderToStaticMarkup(
      <SettingsSection title="About">
        <SettingsRow title="Update track" description="Choose an update track." />
        <SettingsRow title="Diagnostics" description="Local telemetry settings." />
      </SettingsSection>,
    );

    expect(html).toContain("Update track");
    expect(html).not.toContain("Local telemetry settings.");
  });
});
