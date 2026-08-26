# Releasing

Stable GitHub releases are published to npm by
`.github/workflows/publish.yml`. The workflow verifies that the release commit
belongs to `main`, requires a stable `v<package-version>` tag, invokes the same
full Node and OS matrix as pull requests and `main`, and publishes with
provenance. SemVer prerelease versions are intentionally rejected.

## First release

The npm package must exist before npm trusted publishing can be configured.
Bootstrap `v0.1.0` once with a granular npm access token that has read/write
access limited to the `@martinmqz` scope, bypasses 2FA for publishing, and uses
the shortest practical expiration:

1. Add the token as the `NPM_BOOTSTRAP_TOKEN` GitHub Actions repository secret.
2. Merge the release-workflow pull request, wait for `main` CI to pass, and
   record the exact verified commit SHA.
3. Create and push tag `v0.1.0` at that exact commit SHA.
4. Publish a stable GitHub release using the existing `v0.1.0` tag.
5. Confirm the workflow and the package provenance both succeeded.
6. In the package settings on npmjs.com, configure a GitHub Actions trusted
   publisher with:
   - organization or user: `martinmqz`;
   - repository: `agent-guidance-sync`;
   - workflow filename: `publish.yml`;
   - allowed action: `npm publish`.
7. Delete the `NPM_BOOTSTRAP_TOKEN` repository secret and revoke the token on
   npmjs.com. In npm publishing access, require two-factor authentication and
   disallow token-based publishing.

## Later releases

1. Update `version` in `package.json` and merge the change into `main`.
2. Wait for every `main` CI job to pass and record that exact commit SHA.
3. Create and push tag `v<package-version>` at the recorded commit SHA.
4. Publish a stable GitHub release using that existing tag.
5. Verify the Publish workflow, npm version, provenance, and installed CLI:

   ```sh
   npx @martinmqz/agent-guidance-sync@<version> --version
   ```

Do not reuse a package version. npm package name/version pairs are immutable.
