Release checklist
=================

Use this checklist before tagging and releasing a new version to production.

1. Tests
   - [ ] All unit tests pass locally: `pnpm --filter @workspace/api-server run test`
   - [ ] Integration tests pass in CI (requires secrets and network): enable `RUN_INTEGRATION=1` in repository secrets

2. Security
   - [ ] Run `npm audit` or equivalent and address critical issues
   - [ ] Review dependency updates / pin transitive dependencies as needed
   - [ ] Ensure KMS and secret access are scoped to least privilege

3. Infrastructure / Deployment
   - [ ] Verify `deployed.json` and contract addresses are accurate
   - [ ] Deploy to staging and validate all flows end-to-end
   - [ ] Perform canary or smoke tests on staging

4. Observability
   - [ ] Configure metrics scraping (Prometheus) and alerts for failed transactions
   - [ ] Configure logs retention, structured logging levels, and error reporting

5. Release
   - [ ] Bump version, tag the commit, and push the tag
   - [ ] Create release notes with changelog and upgrade steps
   - [ ] Monitor production for regressions and be ready to roll back

6. Post-release
   - [ ] Rotate ephemeral test keys used in CI if any were exposed
   - [ ] Validate backups and monitoring alerts
