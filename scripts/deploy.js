// Plain-English overview: deploys both contracts to whatever node
// NEWCO_RPC_URL points at (default: the local Hardhat node) and prints
// their addresses. This is the one script other NewCo components (like
// newco-payroll) should point at to get real contract addresses to talk to.
//
// Usage:
//   npx hardhat node                 (in one terminal)
//   node scripts/deploy.js           (in another)
//
// It deploys as account #0 (payroll system) and uses account #1 as the
// custodian for ReconciliationLedger's constructor, matching the
// well-known local-node default test accounts - fine for local dev, NOT
// how real deployment keys should ever be handled (see
// docs/DEPLOYING_TO_TESTNET.md for that).

const { ethers } = require("ethers");
const consentArtifact = require("../artifacts-custom/ConsentRegistry.json");
const ledgerArtifact = require("../artifacts-custom/ReconciliationLedger.json");

const RPC_URL = process.env.NEWCO_RPC_URL || "http://127.0.0.1:8545";
const DEPLOYER_KEY =
  process.env.NEWCO_DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CUSTODIAN_ADDRESS =
  process.env.NEWCO_CUSTODIAN_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // local account #1

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

  console.log(`Deploying from ${deployer.address} to ${RPC_URL} ...`);

  const consentFactory = new ethers.ContractFactory(consentArtifact.abi, consentArtifact.bytecode, deployer);
  const consentRegistry = await consentFactory.deploy();
  await consentRegistry.waitForDeployment();
  console.log(`ConsentRegistry deployed at: ${await consentRegistry.getAddress()}`);

  const ledgerFactory = new ethers.ContractFactory(ledgerArtifact.abi, ledgerArtifact.bytecode, deployer);
  // Deposit-window settings are fixed for the life of this ledger. Choose
  // them per the plan's compliance determination (see README).
  const WINDOW_MODE = (process.env.NEWCO_DEPOSIT_WINDOW_MODE || "calendar").toLowerCase();
  if (WINDOW_MODE !== "calendar" && WINDOW_MODE !== "business") {
    throw new Error('NEWCO_DEPOSIT_WINDOW_MODE must be "calendar" or "business"');
  }
  const WINDOW_DAYS = Number(process.env.NEWCO_DEPOSIT_WINDOW_DAYS ?? 7);
  if (!Number.isInteger(WINDOW_DAYS) || WINDOW_DAYS < 0) {
    throw new Error("NEWCO_DEPOSIT_WINDOW_DAYS must be a non-negative integer");
  }
  console.log(`Deposit window: ${WINDOW_DAYS} ${WINDOW_MODE} day(s)`);
  const reconciliationLedger = await ledgerFactory.deploy(
    deployer.address,
    CUSTODIAN_ADDRESS,
    WINDOW_MODE === "business" ? 1 : 0,
    WINDOW_DAYS
  );
  await reconciliationLedger.waitForDeployment();
  console.log(`ReconciliationLedger deployed at: ${await reconciliationLedger.getAddress()}`);
  console.log(`  payrollSystem: ${deployer.address}`);
  console.log(`  custodian:     ${CUSTODIAN_ADDRESS}`);

  console.log("\nCopy these into newco-payroll's environment:");
  console.log(`NEWCO_RPC_URL=${RPC_URL}`);
  console.log(`NEWCO_CONSENT_REGISTRY_ADDRESS=${await consentRegistry.getAddress()}`);
  console.log(`NEWCO_RECONCILIATION_LEDGER_ADDRESS=${await reconciliationLedger.getAddress()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
