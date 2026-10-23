# GitHub verification on your own computer

Payrail is not deployed, so everything below runs on `http://127.0.0.1:4402`. Nothing here touches production settings.

## What was checked
- The OAuth callback is **`<PAYRAIL_PUBLIC_URL>/api/market/github/callback`**. Locally that is `http://127.0.0.1:4402/api/market/github/callback`.
- GitHub (docs, "Authorizing OAuth apps"): the `redirect_uri` must match the app's *Authorization callback URL* exactly (unless wildcard matching is on), and **loopback addresses are allowed**: plain `http://127.0.0.1` works, the port may even differ from the registered one, and GitHub advises `127.0.0.1` or `::1` rather than `localhost`.
- Payrail accepts plain `http` **only** for a loopback address; any other address must be `https`, and `PAYRAIL_PUBLIC_URL` may contain nothing but an origin (no path, query, credentials). Otherwise the server refuses to start. At start it prints the exact callback to register.
- Local and production stay separate: use **two OAuth Apps** (local: `http://127.0.0.1:4402`; production later: your `https://` address) and keep the local values in `.env.local`, which is git-ignored and only loaded by `npm run serve:local`. Production uses `.env` / its own environment.
- Unchanged security: one-time OAuth state bound to the seller, no scopes, token sealed and never returned, write-access check on the repository, the proof file in the repository AND served by the deployed host, endpoint check, one verified host per seller, SSRF protections.

## Steps
1. **Create the OAuth App** (GitHub > Settings > Developer settings > OAuth Apps > New OAuth App):
   - Application name: `Payrail (local)`
   - Homepage URL: `http://127.0.0.1:4402`
   - Application description: optional
   - Authorization callback URL: `http://127.0.0.1:4402/api/market/github/callback`
   - Enable Device Flow: leave off
   Press Register application, then **Generate a new client secret**. Copy the Client ID and the secret to your clipboard only.
2. **Create `.env.local`** next to `.env` (do not paste its contents anywhere):
   ```
   PAYRAIL_GITHUB_CLIENT_ID=<the Client ID>
   PAYRAIL_GITHUB_CLIENT_SECRET=<the client secret>
   PAYRAIL_PUBLIC_URL=http://127.0.0.1:4402
   ```
3. **Start Payrail locally**: `npm run serve:local` (it loads `.env` and then `.env.local`). The log must say `GITHUB VERIFICATION ENABLED ... LOCAL DEVELOPMENT callback to register ...: http://127.0.0.1:4402/api/market/github/callback`. If it says GitHub verification is OFF, one of the three variables is missing.
4. **Open Payrail at exactly `http://127.0.0.1:4402`** (not `localhost`): the browser keeps your seller session per address, and GitHub sends you back to the address in `PAYRAIL_PUBLIC_URL`.
5. **Seller > your listing > Verify with GitHub > Connect GitHub**, approve on GitHub (no permissions are requested), and you return to the listing.
6. Enter your test API repository (`https://github.com/<you>/<repository>`), press **Use this repository**, press the **create it on GitHub** link and **Commit** the proof file, let your host serve it, and press **Check now**.

## How the proof file is served
- Payrail requires the proof value both in the repository (`.well-known/payrail-verification.txt`) and served by the deployed host at `https://<host>/.well-known/payrail-verification.txt`.
- **Locally**, the test API (`npm start` in its repository) serves the committed file from its own folder at `http://127.0.0.1:3000/.well-known/payrail-verification.txt`. That is useful for trying the API, but **Payrail will not call a local API**: it only contacts public `https` hosts on port 443 and blocks loopback and IP addresses (the SSRF protection stays on in local mode). So a listing must point at a public `https` URL.
- **Therefore, even while Payrail runs locally, list the Render address** (`https://payrail-test-apipayrail-test-api.onrender.com/api/hello`). Render serves the proof file once it runs the updated `server.js`: the new code reads the committed `.well-known/payrail-verification.txt` (or the `PAYRAIL_VERIFICATION` environment variable, which wins if set). The updated test API exists as a local commit only; until you push it and Render redeploys, the deployed version serves the proof only through `PAYRAIL_VERIFICATION`. Setting that variable to the listing's token also satisfies Payrail's "deployed host serves the proof" check; you still commit the file to the repository for the repository check.
- A free Render service sleeps after 15 minutes and takes about a minute to wake. Payrail's check waits for it: the deployed-file and endpoint probes try up to three times (10 s, then 30 s, then 30 s) and retry only when the host does not answer at all (timeout, network, temporary DNS). A definite answer (404, wrong content, non-JSON, a blocked address) is judged at once. A host that never answers is reported as a hosting timeout, never as a failed proof, and the listing is not verified. Opening `/health` first still makes the check faster.

## Troubleshooting
- *redirect_uri mismatch on GitHub*: the OAuth App's callback URL must be exactly the address printed in the Payrail log.
- *"sign-in link expired"*: the link lives 10 minutes and works once; press Connect GitHub again.
- *Seller session lost after returning*: you opened Payrail at a different address (for example `localhost`) than `PAYRAIL_PUBLIC_URL`; sign in again at the printed address.
- *"Private repositories are not supported"*: use a public repository, or verify with DNS or the well-known file.
