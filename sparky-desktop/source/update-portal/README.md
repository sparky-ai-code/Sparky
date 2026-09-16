# Sparky founder update portal

This local web portal accepts a Windows Sparky installer, calculates the SHA-512 digest required by Electron, and publishes `latest.yml` plus the installer from `/updates`.

It binds to `127.0.0.1` by default and requires a private founder token of at least 24 characters.

```powershell
$env:SPARKY_FOUNDER_TOKEN = "replace-with-a-long-random-founder-token"
pnpm start:update-portal
```

Open `http://127.0.0.1:4178`, sign in with the founder token, and upload the built `Sparky-*.exe` installer. Do not expose this development server directly to the public internet. Before deployment, put it behind HTTPS and persistent founder authentication, then build Sparky with `SPARKY_UPDATE_URL` set to the public `/updates` URL.
