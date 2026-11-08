require("@nomicfoundation/hardhat-toolbox");

// Solidity compilation for this project is done via the custom
// solc-npm-package script (compile.js), NOT through Hardhat's own
// compile task, because Hardhat's default compiler download
// (binaries.soliditylang.org) is blocked in this sandbox. This config
// exists only so `npx hardhat node` can start a local JSON-RPC network
// for tests and manual deployment to run against.
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {
      chainId: 31337,
    },
  },
};
