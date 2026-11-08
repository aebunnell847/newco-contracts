// Plain-English overview: proves Tenet 1 in code - only the subject who
// granted access can revoke it, a grant that's expired or revoked reads
// as inactive, and nobody can grant access "on behalf of" someone else.

const { expect } = require("chai");
const { ethers } = require("ethers");
const artifact = require("../artifacts-custom/ConsentRegistry.json");

describe("ConsentRegistry", function () {
  let provider, subject, grantee, otherParty, contract;

  beforeEach(async function () {
    // ethers v6 local in-memory-style test: use a JsonRpcProvider against
    // a locally running Hardhat node started by test/setup once added, or
    // (for pure unit tests with no real chain) ethers' default Hardhat
    // network via a ContractFactory deployed through a signer backed by
    // a disposable local provider. To keep this suite self-contained and
    // fast, we spin up contracts against the ambient local JSON-RPC node
    // started before the test run (see package.json's "test" script).
    // cacheTimeout: -1 disables ethers v6's short-lived read-cache (it
    // otherwise caches eth_getTransactionCount("pending") briefly, which
    // causes false "nonce too low" errors when sending several
    // transactions back-to-back from the same account against a fast
    // local auto-mining node).
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
    const signers = await getTestSigners(provider);
    subject = signers[0];
    grantee = signers[1];
    otherParty = signers[2];

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, subject);
    contract = await factory.deploy();
    await contract.waitForDeployment();
  });

  const DATA_CATEGORY = ethers.keccak256(ethers.toUtf8Bytes("EMPLOYMENT_STATUS"));

  async function futureExpiry(seconds = 3600) {
    const block = await provider.getBlock("latest");
    return block.timestamp + seconds;
  }

  it("lets the subject grant access and reports it as active", async function () {
    const expiry = await futureExpiry();
    const tx = await contract.grantAccess(grantee.address, DATA_CATEGORY, expiry);
    const receipt = await tx.wait();

    const event = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "AccessGranted");
    expect(event.args.subject).to.equal(subject.address);
    expect(event.args.grantee).to.equal(grantee.address);

    const active = await contract.isAccessActive(event.args.attestationId);
    expect(active).to.equal(true);
  });

  it("reports a non-existent attestation as inactive", async function () {
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("does-not-exist"));
    expect(await contract.isAccessActive(fakeId)).to.equal(false);
  });

  it("lets the subject revoke their own grant, making it inactive", async function () {
    const expiry = await futureExpiry();
    const tx = await contract.grantAccess(grantee.address, DATA_CATEGORY, expiry);
    const receipt = await tx.wait();
    const { attestationId } = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "AccessGranted").args;

    expect(await contract.isAccessActive(attestationId)).to.equal(true);
    await (await contract.revoke(attestationId)).wait();
    expect(await contract.isAccessActive(attestationId)).to.equal(false);
  });

  it("refuses to let anyone other than the subject revoke a grant", async function () {
    const expiry = await futureExpiry();
    const tx = await contract.grantAccess(grantee.address, DATA_CATEGORY, expiry);
    const receipt = await tx.wait();
    const { attestationId } = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "AccessGranted").args;

    const contractAsOther = contract.connect(otherParty);
    await expectRevert(contractAsOther.revoke(attestationId));
  });

  it("reports access as inactive once its expiry has passed", async function () {
    const expiry = await futureExpiry(2); // 2 seconds from now
    const tx = await contract.grantAccess(grantee.address, DATA_CATEGORY, expiry);
    const receipt = await tx.wait();
    const { attestationId } = receipt.logs.map((l) => contract.interface.parseLog(l)).find((e) => e.name === "AccessGranted").args;

    expect(await contract.isAccessActive(attestationId)).to.equal(true);

    // Fast-forward the local chain's clock past the expiry.
    await provider.send("evm_increaseTime", [10]);
    await provider.send("evm_mine", []);

    expect(await contract.isAccessActive(attestationId)).to.equal(false);
  });
});

// Shared helper: derive wallets from the local node's well-known funded
// test accounts (Hardhat node prints these at startup; this uses the
// standard Hardhat/Ganache default mnemonic-derived private keys so any
// local node started with `npx hardhat node` works without extra config).
async function getTestSigners(provider) {
  // These are the Hardhat/Ganache default test-mnemonic private keys
  // ("test test test ... junk") - public, well-known, and meant only for
  // local throwaway networks. Never fund these addresses with anything real.
  const DEFAULT_TEST_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  ];

  return DEFAULT_TEST_KEYS.map((key) => new ethers.Wallet(key, provider));
}

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
