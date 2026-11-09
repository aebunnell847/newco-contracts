# Context for Claude Code working in this repo

This is `newco-contracts`, one component of the NewCo open-source project
(a blockchain-based HRIS/401(k)/payroll system). Sibling repos:
`newco-payroll` (the application layer that calls into these contracts)
and `newco-docs` (the research corpus and architecture decisions these
contracts implement).

## Ground rules

1. **`ReconciliationLedger` must never gain a code path that blocks,
   reverts, or alters a recorded amount based on a reconciliation
   mismatch.** Every function that compares a contribution to a
   remittance must only emit an event / set a status flag. This is the
   single design constraint that keeps the contract inside ERISA's
   ministerial-function carve-out - see Section 4 of the research corpus
   for exactly why.
2. **Only the data subject can grant or revoke their own `ConsentRegistry`
   attestation.** No admin/owner override path, ever - that would
   undermine Tenet 1.
3. **Compile via `node compile.js`, not `npx hardhat compile`.** Hardhat's
   binary compiler download is blocked in some sandboxes; the solc npm
   package sidesteps that. `hardhat.config.js` exists only to run
   `npx hardhat node` for tests/deployment.
4. Tests run against a real local node (`npx hardhat node`), not mocks -
   keep it that way; it's what makes the test suite actual proof rather
   than an assertion about hand-written stand-ins.
5. The well-known Hardhat/Ganache default test-mnemonic private keys used
   throughout tests and `scripts/deploy.js` are intentionally public and
   must never be used for anything beyond a local/testnet deployment.

## Natural next steps

- Consider adding Mythril alongside the Slither gate already in CI.
- Deploy to a real public testnet (Base Sepolia) - see
  `docs/DEPLOYING_TO_TESTNET.md` for exactly what's needed and why it
  can't be done from inside an agent sandbox.
- Build the SD-JWT VC standards-bridge layer described in Section 2 of
  the research corpus once there's a concrete external-credential need.
- Consider an ERC-4337 account-abstraction wallet for `ConsentRegistry`
  subjects, per Section 7's key-recovery design.
