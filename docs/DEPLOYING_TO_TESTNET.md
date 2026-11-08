# Deploying to a real public testnet

Everything in this repo has been proven against a **local** Hardhat node
so far - that's free, instant, and uses well-known public test keys. Going
from there to a real public testnet (the next real milestone per
`research/blockchain-web3-research-corpus.md` Section 3 - the consent
registry's intended home is an OP-Stack public L2 such as Base) needs two
things that only you can provide, because they involve a real external
account:

## What you need to get, and why I can't get them for you

1. **An RPC endpoint URL for the testnet.** This is how the deploy script
   talks to the actual network instead of your own laptop. Get a free one
   from a provider like Alchemy or Infura: sign up, create an app for
   "Base Sepolia" (or whichever testnet you pick), and copy the HTTPS URL
   it gives you (looks like `https://base-sepolia.g.alchemy.com/v2/<your-key>`).

2. **A funded testnet wallet private key.** This is a wallet that holds
   fake/test ETH (worth nothing) on that specific testnet, used only to
   pay the network's gas fees for deploying and calling the contracts.
   - Generate a fresh wallet just for this (e.g. `npx hardhat accounts` or
     any wallet tool) - **never reuse a real wallet's key for this.**
   - Get free testnet ETH from a faucet (e.g. Base's own Sepolia faucet,
     or a Coinbase/Alchemy-run one - search "Base Sepolia faucet").
   - Copy that wallet's private key.

Both of these are things I genuinely cannot obtain myself - they require
an account on an external service (Alchemy/Infura) and a funded wallet
tied to that service, neither of which I can create or hold on your
behalf from inside this sandbox.

## Once you have both

1. Create a `.env` file in this repo (already excluded by `.gitignore` -
   **never commit this file**):
   ```
   NEWCO_RPC_URL=https://base-sepolia.g.alchemy.com/v2/your-key-here
   NEWCO_DEPLOYER_KEY=0xyour-fresh-testnet-only-private-key
   NEWCO_CUSTODIAN_ADDRESS=0xsome-other-test-address-you-control
   ```
2. Install dotenv and load it at the top of `scripts/deploy.js`:
   ```
   npm install dotenv
   ```
   and add `require("dotenv").config();` as the first line of that file.
3. Run:
   ```
   node scripts/deploy.js
   ```
   It will print both contract addresses on the real testnet, along with
   the three environment variables `newco-payroll` needs to point at them.

## What to expect

- Deployment and each transaction will cost a small amount of testnet
  ETH (free from the faucet) and take a few seconds to confirm, unlike
  the instant, free local node.
- Per the corpus's Section 3 research, a smart-contract write on an
  OP-Stack chain like Base currently runs in the ballpark of a few cents'
  worth of gas at mainnet prices - trivial, but real latency and real
  (if tiny) cost once this moves past testnet to a live network.
- This is still a **testnet**, not mainnet - nothing here should be
  treated as a live production deployment. Moving to mainnet is a much
  bigger step (real money, real audits, real key-management requirements)
  and deserves its own separate decision and write-up when the time comes.

## Security note

A private key in a `.env` file is fine for a *throwaway testnet* wallet
with no real value in it. It is never an acceptable way to hold a
production signing key - that's exactly the kind of key-management
problem the project's longer-term KMS-gateway and MPC/guardian-recovery
design (Section 5 and Section 7 of the corpus) exists to solve properly.
