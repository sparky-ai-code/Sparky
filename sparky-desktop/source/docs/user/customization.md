# Sparky mods: agent-driven appearance and UI customization

Sparky supports **live, declarative mods** for UI theming, custom CSS, and
quick-action panels. This works in the packaged desktop app and hosted client,
without changing bundled assets or requiring a rebuild.

## Ask Sparky to customize itself

With a thread in **Full access** mode, ask:

> Give Sparky a deep blue theme with compact navigation and a Quick Links mod
> containing buttons to open Pull Requests and copy my standup template.

The agent calls `sparky_customization_read` followed by
`sparky_customization_apply`. The second tool requires the revision from
the first and a complete manifest. Mods are saved to
`<server stateDir>/customization.json` (normally
`~/.t3/userdata/customization.json` unless the configured home differs).

Changes appear automatically in all connected clients (polling every few
seconds) and survive restarts. **Settings → Appearance → Sparky mods**
shows the active mod and a simple reset control. Manual JSON editing stays
under **Advanced: edit mod JSON** so most users never have to touch it.
Edits use the revision from when editing began, preventing them from silently
overwriting a newer agent change. Reset requires confirmation.

## Manifest v1

```json
{
  "version": 1,
  "name": "Night Shift",
  "tokens": {
    "--background": "#111827",
    "--foreground": "#f3f4f6",
    "--primary": "#60a5fa",
    "--radius": "0.5rem"
  },
  "css": "[data-slot=\"sidebar-inner\"] { background: linear-gradient(#111827, #1f2937); }",
  "panels": [
    {
      "id": "my-tools",
      "title": "My tools",
      "description": "Shortcuts I use every day",
      "actions": [
        {"id": "prs", "label": "Pull Requests", "kind": "url", "value": "/pull-requests"},
        {"id": "copy-note", "label": "Copy note", "kind": "copy", "value": "Daily update:"}
      ]
    }
  ]
}
```

Design tokens include background, foreground, card, popover, primary,
secondary, muted, accent, border, input, ring, status colors, and radius.
Custom CSS can target component `data-slot` attributes, including layouts,
spacing and animations. Up to eight panels with eight actions each can be
rendered in the collapsible **Mods** dock.

Only HTTPS URLs and recognized in-app routes are allowed for URL actions.
CSS cannot fetch remote resources or include HTML, and no mod executes
JavaScript or directly reads secrets. Server validation runs on both UI
and agent writes, with a 64 KiB size limit and optimistic revision checks.
Saves are atomic, and the backend refuses to load invalid or symlinked files.

## Recovery

If an agent makes the UI unreadable, append `?safe-ui=1` to Sparky's URL
(in a desktop hash route, append it after the route, for example
`#/settings/appearance?safe-ui=1`). This disables custom CSS and panels
without deleting the saved manifest. Go to Appearance and click **Reset mods**.

The agent may also use `sparky_customization_apply` with the default
manifest. The Reset button forces recovery even if the saved file is broken.

## Scope and limitations

These mods alter visual presentation and add *declarative UI actions*.
They do not execute plugins, rewrite app logic, add arbitrary backend tools,
or elevate permissions. Functional application changes still require normal
reviewed source-code changes and tests. This keeps untrusted agent-generated
CSS and UI declarations separate from privileged app internals.

The architecture borrows the live theme management and agent/MCP approach
from T3 Code, but uses Sparky's own authenticated environment routes and
MCP toolkit rather than copying T3's command syntax or UI.
