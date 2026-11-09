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
    // The two writers of the ledger. Each role can hand ITS OWN address to
    // a new one (key rotation, a new system, a cooperative change of
    // provider) via a two-step propose/accept, so a typo can't hand the
    // role to an address nobody controls. There is no admin: neither role
    // can touch the other's address, and nobody can change the deposit-
    // window rules. A lost or stolen key, or an outgoing party that won't
    // cooperate, still means deploying a new ledger.
    //
    // The two roles must always be different addresses: one party able to
    // record both sides could manufacture a "Matched" reconciliation.
    address public payrollSystem;
    address public custodian;
    address public pendingPayrollSystem;
    address public pendingCustodian;

    // How the timely-deposit window is counted. Used only to FLAG a
    // late-looking deposit for human review, never to block one.
    //
    // - CalendarDays: late if remittedAt > withheldAt + N * 24h (to the
    //   second). N = 0 means any delay at all is flagged - the setting for
    //   instant, every-day settlement once the industry supports it.
    // - BusinessDays: N weekdays (Mon-Fri, by UTC date) after the date of
    //   withholding; late if the remittance's UTC date is after that. Bank
    //   holidays are NOT excluded - the chain has no trustworthy holiday
    //   calendar without someone being given power to maintain one - so a
    //   holiday inside the window makes the flag fire a day EARLY. That
    //   errs toward an extra human review, never toward a missed late
    //   deposit.
    //
    // Which mode and length a plan should use (e.g. DOL's 7-business-day
    // small-plan safe harbor under 29 CFR 2510.3-102(a)(2), which only
    // covers plans with fewer than 100 participants) is a compliance
    // decision made at deployment, not by this contract.
    enum DepositWindowMode {
        CalendarDays, // 0
        BusinessDays // 1
    }

    // Fixed at deployment. Changing them means deploying a new ledger:
    // there is deliberately no admin who can alter the rules mid-stream.
    DepositWindowMode public immutable DEPOSIT_WINDOW_MODE;
    uint256 public immutable TIMELY_DEPOSIT_WINDOW_DAYS;
    // Bounds the business-day loop in depositDeadline().
    uint256 public constant MAX_DEPOSIT_WINDOW_DAYS = 60;

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
    event PayrollSystemHandoffProposed(address indexed current, address indexed proposed);
    event PayrollSystemHandedOff(address indexed previous, address indexed next);
    event CustodianHandoffProposed(address indexed current, address indexed proposed);
    event CustodianHandedOff(address indexed previous, address indexed next);

    modifier onlyPayroll() {
        require(msg.sender == payrollSystem, "caller is not the registered payroll system");
        _;
    }

    modifier onlyCustodian() {
        require(msg.sender == custodian, "caller is not the registered custodian");
        _;
    }

    constructor(
        address _payrollSystem,
        address _custodian,
        DepositWindowMode _windowMode,
        uint256 _windowDays
    ) {
        require(_payrollSystem != address(0), "payrollSystem cannot be zero address");
        require(_custodian != address(0), "custodian cannot be zero address");
        require(_payrollSystem != _custodian, "payrollSystem and custodian must be different addresses");
        require(_windowDays <= MAX_DEPOSIT_WINDOW_DAYS, "deposit window too long");
        payrollSystem = _payrollSystem;
        custodian = _custodian;
        DEPOSIT_WINDOW_MODE = _windowMode;
        TIMELY_DEPOSIT_WINDOW_DAYS = _windowDays;
    }

    /// @notice The current payroll system proposes `next` as its successor.
    /// Takes effect only when `next` calls acceptPayrollSystem(). Proposing
    /// address(0) cancels a pending proposal; a new proposal replaces it.
    function proposePayrollSystem(address next) external onlyPayroll {
        require(next != payrollSystem, "already the payroll system");
        require(next != custodian, "payrollSystem and custodian must be different addresses");
        pendingPayrollSystem = next;
        emit PayrollSystemHandoffProposed(payrollSystem, next);
    }

    /// @notice The proposed successor takes over the payroll role.
    function acceptPayrollSystem() external {
        require(pendingPayrollSystem != address(0), "no payroll handoff pending");
        require(msg.sender == pendingPayrollSystem, "caller is not the proposed payroll system");
        // Re-checked here: the custodian may have changed since the proposal.
        require(msg.sender != custodian, "payrollSystem and custodian must be different addresses");
        address previous = payrollSystem;
        payrollSystem = msg.sender;
        pendingPayrollSystem = address(0);
        emit PayrollSystemHandedOff(previous, msg.sender);
    }

    /// @notice The current custodian proposes `next` as its successor.
    /// Takes effect only when `next` calls acceptCustodian(). Proposing
    /// address(0) cancels a pending proposal; a new proposal replaces it.
    function proposeCustodian(address next) external onlyCustodian {
        require(next != custodian, "already the custodian");
        require(next != payrollSystem, "payrollSystem and custodian must be different addresses");
        pendingCustodian = next;
        emit CustodianHandoffProposed(custodian, next);
    }

    /// @notice The proposed successor takes over the custodian role.
    function acceptCustodian() external {
        require(pendingCustodian != address(0), "no custodian handoff pending");
        require(msg.sender == pendingCustodian, "caller is not the proposed custodian");
        require(msg.sender != payrollSystem, "payrollSystem and custodian must be different addresses");
        address previous = custodian;
        custodian = msg.sender;
        pendingCustodian = address(0);
        emit CustodianHandedOff(previous, msg.sender);
    }

    /// @notice The last unix second a deposit for a contribution withheld
    /// at `withheldAt` still counts as timely under this ledger's settings.
    /// Remittances after this are flagged LateDeposit (never blocked).
    function depositDeadline(uint64 withheldAt) public view returns (uint256) {
        if (DEPOSIT_WINDOW_MODE == DepositWindowMode.CalendarDays) {
            return uint256(withheldAt) + TIMELY_DEPOSIT_WINDOW_DAYS * 1 days;
        }
        uint256 day = uint256(withheldAt) / 1 days;
        for (uint256 i = 0; i < TIMELY_DEPOSIT_WINDOW_DAYS; i++) {
            day++;
            while (_isWeekend(day)) day++;
        }
        return (day + 1) * 1 days - 1; // end of that UTC day
    }

    /// @dev Day 0 of unix time (1970-01-01) was a Thursday. With Sunday = 0,
    /// day-of-week = (day + 4) % 7.
    function _isWeekend(uint256 day) internal pure returns (bool) {
        uint256 dow = (day + 4) % 7;
        return dow == 0 || dow == 6;
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

        uint256 deadline = depositDeadline(c.withheldAt);
        if (uint256(r.remittedAt) > deadline) {
            uint256 delaySeconds = uint256(r.remittedAt) - deadline;
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
