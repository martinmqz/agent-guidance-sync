# Releasing

Stable GitHub releases are published to npm by
`.github/workflows/publish.yml`. The workflow verifies that the release commit
belongs to `main`, requires the `v<package-version>` tag convention, runs the
full test and generated-guidance checks, inspects the package, and publishes
with provenance.

## First release

The npm package must exist before npm trusted publishing can be configured.
Bootstrap `v0.1.0` once with a granular npm access token that has read/write
access limited to the `@martinmqz` scope, bypasses 2FA for publishing, and uses
the shortest practical expiration:

1. Add the token as the `NPM_TOKEN` GitHub Actions repository secret.
2. Merge the release-workflow pull request and wait for `main` CI to pass.
3. Publish a stable GitHub release for tag `v0.1.0` at the verified `main`
   commit.
4. Confirm the workflow and the package provenance both succeeded.
5. In the package settings on npmjs.com, configure a GitHub Actions trusted
   publisher with:
   - organization or user: `martinmqz`;
   - repository: `agent-guidance-sync`;
   - workflow filename: `publish.yml`;
   - allowed action: `npm publish`.
6. Delete the `NPM_TOKEN` repository secret. In npm publishing access, require
   two-factor authentication and disallow token-based publishing.

## Later releases

1. Update `version` in `package.json` and merge the change into `main`.
2. Wait for every `main` CI job to pass.
3. Publish a stable GitHub release whose tag is exactly `v<package-version>`.
4. Verify the Publish workflow, npm version, provenance, and installed CLI:

   ```sh
   npx @martinmqz/agent-guidance-sync@<version> --version
   ```

Do not reuse a package version. npm package name/version pairs are immutable.
