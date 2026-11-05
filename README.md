# nx-cache-action

GitHub Action that configures the Nx self-hosted remote cache for a job. It exports `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, which Nx reads in later steps. The cache server is self-hosted; this repository holds only the action.

## Usage

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Evanion/nx-cache-action@v0.1.0
        with:
          server: ${{ vars.NX_SELF_HOSTED_REMOTE_CACHE_SERVER }}
          read-token: ${{ secrets.NX_CACHE_READ_TOKEN }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm nx affected -t lint test build
```

Pin a full commit SHA (`Evanion/nx-cache-action@<40-char sha> # v0.1.0`) or an exact version tag. The action receives a write token, so a pinned SHA guarantees the code that sees it. The major tag `v0` is a convenience: it moves to each new `v0.x.y` release, so a job on `@v0` runs new code without a change on your side.

## Inputs

- `server` (required): cache server origin, `https://` with no path. It is also the audience of the OIDC token.
- `read-token` (required): the project's read token. If it is empty (fork PRs, Dependabot), the action prints a warning and the run has no remote cache.
- `large-upload-threshold` (optional, default `99614720`): bytes. In write mode a cache upload over this goes through the local gateway's upload slot.

## Modes

- Default-branch `push`, `workflow_dispatch` and `schedule` runs with `id-token: write` exchange the job's OIDC token at `POST <server>/v1/oidc/github` for a 1-hour write token for the shared cache.
- `pull_request` runs on `refs/pull/<n>/merge` with `id-token: write` get a 1-hour write token confined to the PR's namespace `pr-<n>`. The action prints `mode: write (pr-<n>)`. That token reads the PR namespace and then the shared cache, and writes only the PR namespace.
- Every other run (`pull_request_target`, other branches, a refused or failed exchange) uses `read-token`. A failed exchange never fails the job.

## Security model

- The action stores no secrets. It reads `read-token` from the job and asks GitHub for an OIDC token, which the server verifies (repository id, owner id, ref, event) before it mints a write token. Every token is masked in the log.
- No token appears in a process argument list: headers and bodies go to `curl` through stdin.
- In write mode the action starts `gateway.mjs` on `127.0.0.1` and points Nx at it. The gateway forwards each request to the server with the `Authorization` header Nx sends and holds no token of its own; it starts with the read token and the OIDC request token removed from its environment. For a `PUT` over `large-upload-threshold` it asks the server for an upload slot, sends the body to the presigned object storage URL the server returns, and confirms the upload. This gets artifacts past Cloudflare's 100 MB request body limit.
- When a large upload fails, the gateway answers Nx `403`, which Nx ignores, and the task is not cached. The post step stops the gateway and copies each "not cached" line into the job summary as a warning.
- Steps after the action can read the write token from the job environment. Do not run untrusted code later in a job that can get write access.

## Requirements

- `id-token: write` in the job's permissions for write mode. Without it the action reads only.
- `bash`, `curl`, `jq` and Node 20 or later on the runner (GitHub-hosted Ubuntu runners have them).
- Write tokens expire after 1 hour. Jobs longer than that lose write access for later tasks.

## License

MIT
