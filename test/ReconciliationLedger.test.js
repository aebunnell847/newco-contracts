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

const CALENDAR = 0;
const BUSINESS = 1;
const DAY = 86400;

// Unix day number -> seconds at UTC midnight. 2026-11-09 is a Monday.
const utc = (isoDate, hh = 12) => Date.parse(isoDate + "T00:00:00Z") / 1000 + hh * 3600;

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
    // Calendar days, 7-day window: the original default behavior.
    contract = await factory.deploy(payroll.address, custodian.address, CALENDAR, 7);
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

describe("ReconciliationLedger deposit window settings", function () {
  let provider, payroll, custodian;
  const employeeId = ethers.keccak256(ethers.toUtf8Bytes("emp-window"));
  let periodCounter = 0;

  before(async function () {
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
    [payroll, custodian] = DEFAULT_TEST_KEYS.map((k) => new ethers.Wallet(k, provider));
  });

  async function deploy(mode, days) {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payroll);
    const c = await factory.deploy(payroll.address, custodian.address, mode, days);
    await c.waitForDeployment();
    return c;
  }

  // Records a contribution at `withheldAt` and a matching remittance at
  // `remittedAt`, returns the resulting status (3 Matched, 5 LateDeposit).
  async function statusFor(c, withheldAt, remittedAt) {
    const period = ethers.keccak256(ethers.toUtf8Bytes("p-" + periodCounter++));
    await (await c.recordContribution(employeeId, period, 100, withheldAt)).wait();
    await (await c.connect(custodian).recordRemittance(employeeId, period, 100, remittedAt)).wait();
    return c.status(employeeId, period);
  }

  it("exposes its mode and window length, fixed at deployment", async function () {
    const c = await deploy(BUSINESS, 7);
    expect(await c.DEPOSIT_WINDOW_MODE()).to.equal(BigInt(BUSINESS));
    expect(await c.TIMELY_DEPOSIT_WINDOW_DAYS()).to.equal(7n);
  });

  it("refuses a window longer than the maximum at deployment", async function () {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payroll);
    await expectRevert(factory.deploy(payroll.address, custodian.address, CALENDAR, 61));
  });

  it("calendar mode: deadline is exactly N x 24h after withholding", async function () {
    const c = await deploy(CALENDAR, 7);
    const w = utc("2026-11-13"); // a Friday
    expect(await c.depositDeadline(w)).to.equal(BigInt(w + 7 * DAY));
    expect(await statusFor(c, w, w + 7 * DAY)).to.equal(3n); // Matched, right at the deadline
    expect(await statusFor(c, w, w + 7 * DAY + 1)).to.equal(5n); // LateDeposit, one second over
  });

  it("calendar mode with a 0-day window flags any delay (instant settlement)", async function () {
    const c = await deploy(CALENDAR, 0);
    const w = utc("2026-11-14"); // Saturday - calendar mode doesn't care
    expect(await statusFor(c, w, w)).to.equal(3n);
    expect(await statusFor(c, w, w + 1)).to.equal(5n);
  });

  it("business mode skips weekends: 7 business days from Friday is the Tuesday 11 days later", async function () {
    const c = await deploy(BUSINESS, 7);
    const w = utc("2026-11-13"); // Friday
    // Mon16 Tue17 Wed18 Thu19 Fri20 Mon23 Tue24 -> deadline end of Tue 2026-11-24 UTC
    expect(await c.depositDeadline(w)).to.equal(BigInt(utc("2026-11-25", 0) - 1));
    expect(await statusFor(c, w, utc("2026-11-24", 23))).to.equal(3n); // Matched
    expect(await statusFor(c, w, utc("2026-11-25", 0))).to.equal(5n); // LateDeposit
  });

  it("business mode is more lenient than calendar mode across a weekend", async function () {
    const w = utc("2026-11-13"); // Friday
    const remitted = utc("2026-11-23"); // 10 calendar days later, the 6th business day
    expect(await statusFor(await deploy(CALENDAR, 7), w, remitted)).to.equal(5n); // late by calendar
    expect(await statusFor(await deploy(BUSINESS, 7), w, remitted)).to.equal(3n); // timely by business days
  });

  it("business mode counts from the next weekday when withholding happens on a weekend", async function () {
    const c = await deploy(BUSINESS, 1);
    // Withheld Saturday 2026-11-14 -> 1 business day later is Monday 2026-11-16
    expect(await c.depositDeadline(utc("2026-11-14"))).to.equal(BigInt(utc("2026-11-17", 0) - 1));
  });

  it("business mode with a 0-day window means the same UTC day", async function () {
    const c = await deploy(BUSINESS, 0);
    expect(await c.depositDeadline(utc("2026-11-11", 9))).to.equal(BigInt(utc("2026-11-12", 0) - 1));
  });

  it("a late deposit is still only flagged, never reverted, in either mode", async function () {
    for (const mode of [CALENDAR, BUSINESS]) {
      const c = await deploy(mode, 1);
      const w = utc("2026-11-10");
      expect(await statusFor(c, w, w + 30 * DAY)).to.equal(5n); // recorded and flagged, no revert
    }
  });
});

describe("ReconciliationLedger role handoff", function () {
  // Well-known local Hardhat accounts #3 and #4 (public test keys).
  const NEXT_KEYS = [
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ];
  let provider, payroll, custodian, outsider, nextPayroll, nextCustodian, c;
  const employeeId = ethers.keccak256(ethers.toUtf8Bytes("emp-handoff"));
  let n = 0;
  const newPeriod = () => ethers.keccak256(ethers.toUtf8Bytes("handoff-" + n++));

  beforeEach(async function () {
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
    [payroll, custodian, outsider] = DEFAULT_TEST_KEYS.map((k) => new ethers.Wallet(k, provider));
    [nextPayroll, nextCustodian] = NEXT_KEYS.map((k) => new ethers.Wallet(k, provider));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payroll);
    c = await factory.deploy(payroll.address, custodian.address, CALENDAR, 7);
    await c.waitForDeployment();
  });

  const send = async (p) => (await p).wait();

  it("refuses to deploy with the same address in both roles", async function () {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payroll);
    await expectRevert(factory.deploy(payroll.address, payroll.address, CALENDAR, 7));
  });

  it("payroll hands off in two steps; only then does the new address take over", async function () {
    await send(c.proposePayrollSystem(nextPayroll.address));
    expect(await c.payrollSystem()).to.equal(payroll.address); // not yet
    expect(await c.pendingPayrollSystem()).to.equal(nextPayroll.address);

    const receipt = await send(c.connect(nextPayroll).acceptPayrollSystem());
    const ev = receipt.logs.map((l) => c.interface.parseLog(l)).find((e) => e.name === "PayrollSystemHandedOff");
    expect(ev.args.previous).to.equal(payroll.address);
    expect(ev.args.next).to.equal(nextPayroll.address);
    expect(await c.payrollSystem()).to.equal(nextPayroll.address);
    expect(await c.pendingPayrollSystem()).to.equal(ethers.ZeroAddress);

    const now = (await provider.getBlock("latest")).timestamp;
    await expectRevert(c.connect(payroll).recordContribution(employeeId, newPeriod(), 1, now)); // old key locked out
    await send(c.connect(nextPayroll).recordContribution(employeeId, newPeriod(), 1, now)); // new key works
  });

  it("custodian hands off in two steps; only then does the new address take over", async function () {
    await send(c.connect(custodian).proposeCustodian(nextCustodian.address));
    expect(await c.custodian()).to.equal(custodian.address);
    await send(c.connect(nextCustodian).acceptCustodian());
    expect(await c.custodian()).to.equal(nextCustodian.address);

    const now = (await provider.getBlock("latest")).timestamp;
    await expectRevert(c.connect(custodian).recordRemittance(employeeId, newPeriod(), 1, now));
    await send(c.connect(nextCustodian).recordRemittance(employeeId, newPeriod(), 1, now));
  });

  it("only the current holder of a role can propose its successor - no one can touch the other role", async function () {
    await expectRevert(c.connect(outsider).proposePayrollSystem(outsider.address));
    await expectRevert(c.connect(custodian).proposePayrollSystem(nextPayroll.address)); // custodian can't move payroll
    await expectRevert(c.connect(outsider).proposeCustodian(outsider.address));
    await expectRevert(c.connect(payroll).proposeCustodian(nextCustodian.address)); // payroll can't move custodian
  });

  it("only the proposed address can accept, and only while a handoff is pending", async function () {
    await expectRevert(c.connect(nextPayroll).acceptPayrollSystem()); // nothing pending
    await send(c.proposePayrollSystem(nextPayroll.address));
    await expectRevert(c.connect(outsider).acceptPayrollSystem());
    await expectRevert(c.connect(payroll).acceptPayrollSystem());
  });

  it("a proposal can be replaced or cancelled before it is accepted", async function () {
    await send(c.proposePayrollSystem(outsider.address));
    await send(c.proposePayrollSystem(nextPayroll.address)); // replace
    await expectRevert(c.connect(outsider).acceptPayrollSystem());
    await send(c.proposePayrollSystem(ethers.ZeroAddress)); // cancel
    await expectRevert(c.connect(nextPayroll).acceptPayrollSystem());
    expect(await c.payrollSystem()).to.equal(payroll.address);
  });

  it("never lets one address hold both roles, even if the other role moved after the proposal", async function () {
    await expectRevert(c.proposePayrollSystem(custodian.address)); // direct attempt
    await expectRevert(c.proposePayrollSystem(payroll.address)); // no-op proposal refused too

    // Payroll proposes X; meanwhile the custodian hands off to X; X then
    // tries to also accept payroll. Must be refused.
    await send(c.proposePayrollSystem(nextCustodian.address));
    await send(c.connect(custodian).proposeCustodian(nextCustodian.address));
    await send(c.connect(nextCustodian).acceptCustodian());
    await expectRevert(c.connect(nextCustodian).acceptPayrollSystem());
    expect(await c.payrollSystem()).to.equal(payroll.address);
  });

  it("entries recorded before a handoff stay intact and reconcile across it", async function () {
    const period = newPeriod();
    const withheldAt = (await provider.getBlock("latest")).timestamp;
    await send(c.recordContribution(employeeId, period, 5_000, withheldAt)); // old payroll

    await send(c.proposePayrollSystem(nextPayroll.address));
    await send(c.connect(nextPayroll).acceptPayrollSystem());
    await send(c.connect(custodian).proposeCustodian(nextCustodian.address));
    await send(c.connect(nextCustodian).acceptCustodian());

    await send(c.connect(nextCustodian).recordRemittance(employeeId, period, 5_000, withheldAt + 3600)); // new custodian
    expect(await c.status(employeeId, period)).to.equal(3n); // Matched
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
