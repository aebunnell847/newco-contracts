# newco-contracts

The two Solidity contracts at the core of NewCo, each implementing one of
the project's two founding tenets (see
[`newco-docs/research/blockchain-web3-research-corpus.md`](../newco-docs)
for the full research and reasoning behind every decision here):

- **`ConsentRegistry.sol`** - Tenet 1: the employee's own wallet, and
  nothing else, controls who can access which category of their data.
  Only the subject who created a grant can revoke it.
- **`ReconciliationLedger.sol`** - Tenet 2: an immutable record comparing
  what payroll withheld against what the plan's custodian confirms it
  received. **It never blocks, holds, or auto-corrects anything - it only
  ever records facts and flags discrepancies for a human to resolve.**
  That one guardrail is what keeps this inside ERISA's ministerial-function
  carve-out (DOL Interpretive Bulletin 75-8, Q&A D-2) instead of crossing
  into fiduciary territory.

## Why compilation works differently here

Hardhat's default Solidity compiler download (`binaries.soliditylang.org`)
is blocked in some sandboxed environments. This repo compiles via the
`solc` **npm package** instead (a pure JS/WASM build of the compiler,
distributed through the normal npm registry) using the custom
`compile.js` script, which writes ABI+bytecode to `artifacts-custom/`.
Hardhat itself is still used, but only for running a local test network
(`npx hardhat node`) - not for compiling.

## Running the tests

Tests talk to a **real local blockchain node**, not a mock - they prove
the contracts actually work when called over JSON-RPC, the same way any
real client eventually will.

```
npm install
npm run node        # in one terminal - starts a local chain, leave it running
npm test            # in another terminal - compiles + runs all tests
```

12 tests across both contracts: grants, revocation, expiry, access
control on who can call what, and all three reconciliation outcomes
(Matched, AmountMismatch, LateDeposit) - including an explicit assertion
that a mismatch never reverts or alters the originally recorded amount.

## Deploying

```
npm run deploy
```

Deploys both contracts to whatever `NEWCO_RPC_URL` points at (defaults to
the local node) and prints the addresses, ready to hand to `newco-payroll`.
To deploy to a real public testnet instead of your own machine, see
[`docs/DEPLOYING_TO_TESTNET.md`](docs/DEPLOYING_TO_TESTNET.md) - it needs
two things only you can provide (an RPC endpoint and a funded testnet
wallet), spelled out there.

## What's not here yet

Static analysis (Slither/Mythril) in CI, a mainnet deployment plan, and
the SD-JWT VC standards-bridge layer described in Section 2 of the
research corpus - all listed as open next steps there.
