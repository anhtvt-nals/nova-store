# GOST GitHub Actions sandbox template

This repository is a manual, short-lived GOST v3 connectivity test for a master VPS. Each GitHub Actions job runs on an ephemeral GitHub-hosted runner and exits after at most one hour. It is not a production proxy worker or a replacement for E2B/Runloop.

## Control plane

The workflow receives only an opaque task ID and a public HTTPS control-plane URL. It obtains a short-lived GitHub Actions OIDC token, which Nodenesia verifies against GitHub's signing keys and expected repository/workflow claims. Only then does the API return the one-time GOST configuration over HTTPS.

No GOST, SOCKS, or master-VPS credential is stored in this repository, passed in workflow inputs, or printed in logs. Do not dispatch this workflow manually: a task ID is valid only for the workflow run created by Nodenesia.

## Run

1. Nodenesia dispatches the workflow after reserving a unique bind port.
2. The API verifies the runner's OIDC identity before releasing its configuration.
3. When the run ends or is cancelled, the hosted runner is discarded and its tunnel is closed.

The `github:create-gost-template` bootstrap script creates the public repository `nodenesia-gost-template` from these files and marks it as a GitHub template. Then `github:create-gost-sandbox` creates the public `nodenesia-gost-sandbox` repository in each target account through GitHub's template-generation API. Both scripts receive credentials only as `GITHUB_PROVIDER_API_KEY=GITHUB_OWNER|GITHUB_API_KEY`, and deliberately avoid uploading GOST secrets: add them from GitHub’s repository-secret UI or your own secret-management process.
