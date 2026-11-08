// Compiles every .sol file in contracts/ using the solc npm package
// (pure JS/WASM compiler from the npm registry) instead of Hardhat's
// normal compiler-download mechanism, which is blocked in this sandbox
// (binaries.soliditylang.org is not on the network allowlist). Output
// goes to artifacts-custom/<ContractName>.json as {abi, bytecode}.

const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "contracts");
const OUTPUT_DIR = path.join(__dirname, "artifacts-custom");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const solFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));

const sources = {};
for (const file of solFiles) {
  sources[file] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, file), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  for (const e of output.errors) console.log(e.formattedMessage);
  if (fatal.length > 0) {
    console.error(`\nCompilation failed with ${fatal.length} error(s).`);
    process.exit(1);
  }
}

for (const file of solFiles) {
  const contractsInFile = output.contracts[file];
  for (const contractName of Object.keys(contractsInFile)) {
    const contract = contractsInFile[contractName];
    const artifact = {
      contractName,
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
    };
    const outPath = path.join(OUTPUT_DIR, `${contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`Compiled ${contractName} -> ${path.relative(__dirname, outPath)}`);
  }
}
