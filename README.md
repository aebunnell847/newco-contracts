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

31 tests across both contracts: grants, revocation, expiry, access
control on who can call what, and all three reconciliation outcomes
(Matched, AmountMismatch, LateDeposit) under both deposit-window modes -
including an explicit assertion
that a mismatch never reverts or alters the originally recorded amount.

Every ledger entry stores two times: the one the caller claims
(`withheldAt` / `remittedAt`, which drives the LateDeposit flag) and
`recordedAt`, the block timestamp when the entry landed, which the
caller can't choose. The flag logic is unchanged; the second time
just makes a backdated claim visible to an auditor.

## Deploying

```
npm run deploy
```

Deploys both contracts to whatever `NEWCO_RPC_URL` points at (defaults to
the local node) and prints the addresses, ready to hand to `newco-payroll`.

### Deposit window (fixed per ledger)

`ReconciliationLedger` flags a remittance as `LateDeposit` when it lands
after the plan's timely-deposit window. The window is set at deployment
and can't be changed afterwards. Changing it means deploying a new
ledger, because no admin is given power to alter the rules mid-stream.

| Env var | Values | Default |
|---|---|---|
| `NEWCO_DEPOSIT_WINDOW_MODE` | `calendar` or `business` | `calendar` |
| `NEWCO_DEPOSIT_WINDOW_DAYS` | `0`-`60` | `7` |

- **calendar**: late if the remittance is more than N x 24 hours after
  withholding. `calendar` with `0` flags any delay at all, which is the
  setting for instant, every-day settlement once the industry supports
  it.
- **business**: N weekdays (Mon-Fri, by UTC date) after the withholding
  date. Bank holidays are not excluded, so a holiday inside the window
  makes the flag fire a day early. That means an extra human review,
  never a missed late deposit.

Which setting a plan should use is a compliance decision. For example,
DOL's 7-business-day safe harbor (29 CFR 2510.3-102(a)(2)) only covers
plans with fewer than 100 participants. Either way the ledger only
flags; it never blocks a deposit.
To deploy to a real public testnet instead of your own machine, see
[`docs/DEPLOYING_TO_TESTNET.md`](docs/DEPLOYING_TO_TESTNET.md) - it needs
two things only you can provide (an RPC endpoint and a funded testnet
wallet), spelled out there.

## What the ledger makes public, on purpose

Everything a contract stores or emits is readable by anyone, forever.
For `ReconciliationLedger` that is deliberate. Each entry's amounts and
times are public so anyone can spot-check that what payroll withheld
matches what the custodian received, without having to trust either
side's word.

What is **not** public is who an entry belongs to. `employeeId` is a
keyed hash that only the payroll system can compute (see
`newco-payroll`'s README, "Employee IDs on the public ledger"), so a
guessed employee number can't be matched to an entry. Personal data
never goes on-chain. If a future change would put a name, an SSN, or an
unkeyed hash of one into a contract call or event, treat that as a bug.

## Who can write the ledger, and handing a role off

`ReconciliationLedger` has two writers: the **payroll system** (records
contributions) and the **custodian** (records remittances). They must
always be different addresses; the contract refuses to let one address
hold both, since that party could record both sides and manufacture a
`Matched` result.

Each role can hand **its own** address to a new one, for a key rotation,
a new system, or a cooperative change of provider:

1. The current holder calls `proposePayrollSystem(next)` /
   `proposeCustodian(next)`.
2. `next` calls `acceptPayrollSystem()` / `acceptCustodian()` from its
   own address.

Two steps mean a mistyped address can't take the role: an address
nobody controls can never accept. A pending proposal can be replaced,
or cancelled by proposing the zero address. Every step emits an event.
Entries recorded before a handoff stay exactly as they were.

There is **no admin**. Neither role can move the other, and nobody can
change the deposit-window rules. What this doesn't cover:

- **A lost key, or an outgoing party that won't cooperate.** Only the
  current holder can start a handoff, so recovering means deploying a
  new ledger.
- **A stolen key.** The thief can hand the role to themselves and lock
  the real party out. That's no worse than what a stolen key already
  allows (writing false entries); recovery is again a new ledger. Keep
  role keys in hardware or multi-signature wallets.

## What's not here yet

Static analysis (Slither/Mythril) in CI, a mainnet deployment plan, and
the SD-JWT VC standards-bridge layer described in Section 2 of the
research corpus - all listed as open next steps there.
