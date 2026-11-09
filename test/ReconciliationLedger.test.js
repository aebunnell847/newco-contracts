// Plain-English overview: proves Tenet 2 and the one hard guardrail -
// contributions and remittances are recorded independently, a match is
// flagged as matched, a mismatch is flagged (never blocked), a late
// deposit is flagged, and only the registered payroll/custodian addresses
// can write their respective side of the ledger.

const { expect } = require("chai");
const { ethers } = require("ethers");
const artifact = require("../artifacts-custom/ReconciliationLedger.json");

const DEFAULT_TEST_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

describe("ReconciliationLedger", function () {
  let provider, payroll, custodian, outsider, contract;
  const employeeId = ethers.keccak256(ethers.toUtf8Bytes("emp-001"));
  const payPeriod = ethers.keccak256(ethers.toUtf8Bytes("2026-P01"));

  beforeEach(async function () {
    // cacheTimeout: -1 avoids ethers v6's brief read-cache causing false
    // "nonce too low" errors across back-to-back sends on a fast local node.
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
    [payroll, custodian, outsider] = DEFAULT_TEST_KEYS.map((k) => new ethers.Wallet(k, provider));

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payroll);
    contract = await factory.deploy(payroll.address, custodian.address);
    await contract.waitForDeployment();
  });

  async function latestBlockTimestamp() {
    const block = await provider.getBlock("latest");
    return block.timestamp;
  }

  it("reports NoRecord before anything has been written", async function () {
    expect(await contract.status(employeeId, payPeriod)).to.equal(0n); // NoRecord
  });

  it("reports ContributionOnly after payroll records a withholding with no remittance yet", async function () {
    const now = await latestBlockTimestamp();
    await (await contract.recordContribution(employeeId, payPeriod, 10_000, now)).wait();
    expect(await contract.status(employeeId, payPeriod)).to.equal(1n); // ContributionOnly
  });

  it("flags Matched when both sides agree and the deposit is within the 7-day window", async function () {
    const withheldAt = await latestBlockTimestamp();
    await (await contract.recordContribution(employeeId, payPeriod, 10_000, withheldAt)).wait();

    const remittedAt = withheldAt + 60 * 60 * 24 * 2; // 2 days later - within the window
    const contractAsCustodian = contract.connect(custodian);
    const tx = await contractAsCustodian.recordRemittance(employeeId, payPeriod, 10_000, remittedAt);
    const receipt = await tx.wait();

    const matchedEvent = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "ReconciliationMatched");
    expect(matchedEvent).to.exist;
    expect(await contract.status(employeeId, payPeriod)).to.equal(3n); // Matched
  });

  it("flags AmountMismatch - and does NOT revert or block - when the amounts disagree", async function () {
    const withheldAt = await latestBlockTimestamp();
    await (await contract.recordContribution(employeeId, payPeriod, 10_000, withheldAt)).wait();

    const contractAsCustodian = contract.connect(custodian);
    const tx = await contractAsCustodian.recordRemittance(employeeId, payPeriod, 9_500, withheldAt + 3600);
    const receipt = await tx.wait(); // must not revert - the whole point of the guardrail

    const mismatchEvent = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "ReconciliationAmountMismatch");
    expect(mismatchEvent.args.contributionAmountCents).to.equal(10_000n);
    expect(mismatchEvent.args.remittanceAmountCents).to.equal(9_500n);
    expect(await contract.status(employeeId, payPeriod)).to.equal(4n); // AmountMismatch

    // Critically: the originally recorded contribution amount is untouched.
    const stored = await contract.contributions(ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [employeeId, payPeriod]));
    expect(stored.amountCents).to.equal(10_000n);
  });

  it("flags LateDeposit when amounts match but remittance landed after the 7-day window", async function () {
    const withheldAt = await latestBlockTimestamp();
    await (await contract.recordContribution(employeeId, payPeriod, 10_000, withheldAt)).wait();

    const remittedAt = withheldAt + 60 * 60 * 24 * 10; // 10 days later - past the window
    const contractAsCustodian = contract.connect(custodian);
    const tx = await contractAsCustodian.recordRemittance(employeeId, payPeriod, 10_000, remittedAt);
    const receipt = await tx.wait();

    const lateEvent = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "ReconciliationLateDeposit");
    expect(lateEvent).to.exist;
    expect(await contract.status(employeeId, payPeriod)).to.equal(5n); // LateDeposit
  });

  it("refuses a recordContribution call from anyone other than the registered payroll system", async function () {
    const now = await latestBlockTimestamp();
    const contractAsOutsider = contract.connect(outsider);
    await expectRevert(contractAsOutsider.recordContribution(employeeId, payPeriod, 10_000, now));
  });

  it("refuses a recordRemittance call from anyone other than the registered custodian", async function () {
    const now = await latestBlockTimestamp();
    const contractAsOutsider = contract.connect(outsider);
    await expectRevert(contractAsOutsider.recordRemittance(employeeId, payPeriod, 10_000, now));
  });

  it("stores the chain's own block timestamp alongside each caller-supplied time", async function () {
    const key = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [employeeId, payPeriod]);
    const claimedWithheldAt = (await latestBlockTimestamp()) - 3600; // caller says an hour ago

    const cReceipt = await (await contract.recordContribution(employeeId, payPeriod, 10_000, claimedWithheldAt)).wait();
    const cBlock = await provider.getBlock(cReceipt.blockNumber);
    const c = await contract.contributions(key);
    expect(c.withheldAt).to.equal(BigInt(claimedWithheldAt));
    expect(c.recordedAt).to.equal(BigInt(cBlock.timestamp));

    const cEvent = cReceipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "ContributionRecorded");
    expect(cEvent.args.recordedAt).to.equal(BigInt(cBlock.timestamp));

    const rReceipt = await (await contract.connect(custodian).recordRemittance(employeeId, payPeriod, 10_000, claimedWithheldAt)).wait();
    const rBlock = await provider.getBlock(rReceipt.blockNumber);
    const r = await contract.remittances(key);
    expect(r.recordedAt).to.equal(BigInt(rBlock.timestamp));

    const rEvent = rReceipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "RemittanceRecorded");
    expect(rEvent.args.recordedAt).to.equal(BigInt(rBlock.timestamp));
  });

  it("makes a backdated remittance visible without changing how it is flagged", async function () {
    // Payroll withholds now; the custodian only records the remittance 10
    // days later but CLAIMS it arrived 1 day after withholding.
    const key = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [employeeId, payPeriod]);
    const withheldAt = await latestBlockTimestamp();
    await (await contract.recordContribution(employeeId, payPeriod, 10_000, withheldAt)).wait();

    await provider.send("evm_increaseTime", [60 * 60 * 24 * 10]);
    await provider.send("evm_mine", []);

    const claimedRemittedAt = withheldAt + 60 * 60 * 24;
    await (await contract.connect(custodian).recordRemittance(employeeId, payPeriod, 10_000, claimedRemittedAt)).wait();

    // Flag logic is unchanged and still uses the caller's claimed times:
    // this is Matched, exactly as before. The ledger records; it doesn't judge.
    expect(await contract.status(employeeId, payPeriod)).to.equal(3n); // Matched

    // ...but the chain-attested time exposes the gap for a human to review.
    const r = await contract.remittances(key);
    const gapDays = Number(r.recordedAt - r.remittedAt) / 86400;
    expect(gapDays).to.be.greaterThan(8);
  });
});

// We're running tests via plain mocha (not `npx hardhat test`), so
// Hardhat's chai-matchers plugin (which would give us `.to.be.reverted`)
// isn't loaded. This is a minimal stand-in: assert the promise rejects.
async function expectRevert(promise) {
  let threw = false;
  try {
    await promise;
  } catch (err) {
    threw = true;
  }
  if (!threw) throw new Error("expected the transaction to revert, but it succeeded");
}
