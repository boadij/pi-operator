# Contributing

Use feature branches and Conventional Commit titles. PRs require CI and should be squash merged; do not push directly to protected `main`. Keep changes minimal and within the documented product scope. Never commit credentials, private session data, or other sensitive information.

Run `npm ci && npm run validate && npm pack --dry-run --json` before submitting. Releases are managed by Release Please; publishing uses npm trusted publishing and requires repository/workflow configuration by an administrator.

Before the first release, configure npm trusted publishers for the exact repository/workflow names in `.github/workflows/release.yml` and `.github/workflows/preview.yml`. Configure the `NPM_TOKEN` Actions secret for preview-tag cleanup. Require the `CI` status check on protected `main` and allow squash merging.
