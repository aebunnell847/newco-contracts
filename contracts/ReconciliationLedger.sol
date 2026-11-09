// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReconciliationLedger
/// @notice Implements NewCo's Tenet 2: a 401(k) administrator's real job
/// is reconciling what payroll withheld against what the plan's custodian
/// confirms it received - this contract is that shared, tamper-evident
/// record. It never holds, represents, or moves plan assets itself.
///
/// THE ONE GUARDRAIL THAT MATTERS (see research/blockchain-web3-research-corpus.md
/// Section 4): this contract NEVER blocks, holds, or auto-corrects a
/// remittance. It only ever RECORDS facts and FLAGS discrepancies for a
/// human/ministerial process to resolve. That is what keeps this inside
/// DOL Interpretive Bulletin 75-8's ministerial-function carve-out rather
/// than crossing into ERISA fiduciary territory. Do not add any function
/// that reverts, withholds, or alters a recorded amount based on a
/// mismatch - flag it and move on.
contract ReconciliationLedger {
    address public payrollSystem;
    address public custodian;

    // DOL's 7-business-day safe harbor for timely deposit of participant
    // contributions (29 CFR 2510.3-102). This constant is used only to
    // FLAG a late-looking deposit for human review, never to block one.
    uint256 public constant TIMELY_DEPOSIT_WINDOW_DAYS = 7;

    enum Status {
        NoRecord, // 0 - neither a contribution nor a remittance recorded yet
        ContributionOnly, // 1 - payroll withheld, custodian hasn't confirmed receipt yet
        RemittanceOnly, // 2 - custodian recorded receipt before payroll recorded the withholding
        Matched, // 3 - amounts match and the deposit landed within the timely-deposit window
        AmountMismatch, // 4 - amounts recorded by each side don't agree - flagged, not blocked
        LateDeposit // 5 - amounts match, but the gap between withholding and remittance exceeded the window
    }

    // `withheldAt` / `remittedAt` are what the CALLER says happened, and they
    // drive the LateDeposit flag below. `recordedAt` is block.timestamp when
    // the entry landed - a time the chain itself attests to, which the caller
    // can't choose. Recording both makes a backdated (or forward-dated) claim
    // visible to anyone auditing the ledger. Neither one ever blocks anything.
    struct Contribution {
        uint256 amountCents;
        uint64 withheldAt;
        bool recorded;
        uint64 recordedAt;
    }

    struct Remittance {
        uint256 amountCents;
        uint64 remittedAt;
        bool recorded;
        uint64 recordedAt;
    }

    mapping(bytes32 => Contribution) public contributions;
    mapping(bytes32 => Remittance) public remittances;
    mapping(bytes32 => Status) private _reconciliationStatus;

    event ContributionRecorded(bytes32 indexed key, bytes32 employeeId, bytes32 payPeriod, uint256 amountCents, uint64 withheldAt, uint64 recordedAt);
    event RemittanceRecorded(bytes32 indexed key, bytes32 employeeId, bytes32 payPeriod, uint256 amountCents, uint64 remittedAt, uint64 recordedAt);
    event ReconciliationMatched(bytes32 indexed key);
    event ReconciliationAmountMismatch(bytes32 indexed key, uint256 contributionAmountCents, uint256 remittanceAmountCents);
    event ReconciliationLateDeposit(bytes32 indexed key, uint256 delaySeconds);

    modifier onlyPayroll() {
        require(msg.sender == payrollSystem, "caller is not the registered payroll system");
        _;
    }

    modifier onlyCustodian() {
        require(msg.sender == custodian, "caller is not the registered custodian");
        _;
    }

    constructor(address _payrollSystem, address _custodian) {
        require(_payrollSystem != address(0), "payrollSystem cannot be zero address");
        require(_custodian != address(0), "custodian cannot be zero address");
        payrollSystem = _payrollSystem;
        custodian = _custodian;
    }

    function _key(bytes32 employeeId, bytes32 payPeriod) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(employeeId, payPeriod));
    }

    /// @notice Payroll records what it withheld for one employee, one pay
    /// period. Only the registered payroll system may call this.
    function recordContribution(
        bytes32 employeeId,
        bytes32 payPeriod,
        uint256 amountCents,
        uint64 withheldAt
    ) external onlyPayroll {
        bytes32 key = _key(employeeId, payPeriod);
        require(!contributions[key].recorded, "contribution already recorded for this employee/pay period");

        uint64 recordedAt = uint64(block.timestamp);
        contributions[key] = Contribution({
            amountCents: amountCents,
            withheldAt: withheldAt,
            recorded: true,
            recordedAt: recordedAt
        });
        emit ContributionRecorded(key, employeeId, payPeriod, amountCents, withheldAt, recordedAt);

        _tryReconcile(key);
    }

    /// @notice The custodian records what it actually received for one
    /// employee, one pay period. Only the registered custodian may call this.
    function recordRemittance(
        bytes32 employeeId,
        bytes32 payPeriod,
        uint256 amountCents,
        uint64 remittedAt
    ) external onlyCustodian {
        bytes32 key = _key(employeeId, payPeriod);
        require(!remittances[key].recorded, "remittance already recorded for this employee/pay period");

        uint64 recordedAt = uint64(block.timestamp);
        remittances[key] = Remittance({
            amountCents: amountCents,
            remittedAt: remittedAt,
            recorded: true,
            recordedAt: recordedAt
        });
        emit RemittanceRecorded(key, employeeId, payPeriod, amountCents, remittedAt, recordedAt);

        _tryReconcile(key);
    }

    /// @dev Runs whenever either side records a new entry. If both sides
    /// now have a record for this key, compare them and FLAG the outcome.
    /// This function never reverts and never alters either stored amount -
    /// it only ever reads them and emits/records what it found.
    function _tryReconcile(bytes32 key) internal {
        Contribution storage c = contributions[key];
        Remittance storage r = remittances[key];

        if (!c.recorded || !r.recorded) {
            return; // nothing to reconcile yet - status() derives NoRecord/ContributionOnly/RemittanceOnly on the fly
        }

        if (c.amountCents != r.amountCents) {
            _reconciliationStatus[key] = Status.AmountMismatch;
            emit ReconciliationAmountMismatch(key, c.amountCents, r.amountCents);
            return;
        }

        uint256 windowSeconds = TIMELY_DEPOSIT_WINDOW_DAYS * 1 days;
        if (uint256(r.remittedAt) > uint256(c.withheldAt) + windowSeconds) {
            uint256 delaySeconds = uint256(r.remittedAt) - uint256(c.withheldAt) - windowSeconds;
            _reconciliationStatus[key] = Status.LateDeposit;
            emit ReconciliationLateDeposit(key, delaySeconds);
            return;
        }

        _reconciliationStatus[key] = Status.Matched;
        emit ReconciliationMatched(key);
    }

    /// @notice Current reconciliation status for one employee/pay period,
    /// as a uint8 matching the Status enum order above (0-5).
    function status(bytes32 employeeId, bytes32 payPeriod) external view returns (uint8) {
        bytes32 key = _key(employeeId, payPeriod);
        Contribution storage c = contributions[key];
        Remittance storage r = remittances[key];

        if (!c.recorded && !r.recorded) return uint8(Status.NoRecord);
        if (c.recorded && !r.recorded) return uint8(Status.ContributionOnly);
        if (!c.recorded && r.recorded) return uint8(Status.RemittanceOnly);
        return uint8(_reconciliationStatus[key]);
    }
}
