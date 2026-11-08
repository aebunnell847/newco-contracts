// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ConsentRegistry
/// @notice Implements NewCo's Tenet 1: the EMPLOYEE's own wallet controls
/// which downstream entities may access which category of their data.
/// NewCo never unilaterally decides who sees what - this contract is the
/// on-chain record of grants the data subject themselves made, and the
/// only authority that can revoke a grant is that same subject.
///
/// This is intentionally an EAS-style flat attestation registry (see
/// research/blockchain-web3-research-corpus.md Section 2) rather than a
/// full W3C DID/VC implementation - it's the fast-to-ship v1, with a
/// standards-bridge layer planned on top of it later.
///
/// What this contract stores is ONLY the fact of a grant/revocation -
/// never the underlying PII itself. `dataCategory` is a category label
/// (e.g. keccak256("EMPLOYMENT_STATUS")), not the data.
contract ConsentRegistry {
    struct Attestation {
        address subject; // the employee/individual who owns the data and granted access
        address grantee; // the downstream entity allowed to access it
        bytes32 dataCategory; // which category of data this grant covers
        uint64 expiry; // unix timestamp after which this grant is no longer active
        bool revoked; // true once the subject has explicitly revoked it
        uint64 grantedAt;
        uint64 revokedAt;
    }

    mapping(bytes32 => Attestation) public attestations;

    // Per-subject nonce, so two grants made in the same block by the same
    // subject still get distinct attestationIds.
    mapping(address => uint256) private _nonces;

    event AccessGranted(
        bytes32 indexed attestationId,
        address indexed subject,
        address indexed grantee,
        bytes32 dataCategory,
        uint64 expiry
    );

    event AccessRevoked(bytes32 indexed attestationId, address indexed subject, uint64 revokedAt);

    /// @notice The data subject (msg.sender) grants `grantee` access to
    /// `dataCategory` until `expiry`. Only the subject can create a grant
    /// over their own data - there is no "grant on behalf of" path, by design.
    function grantAccess(
        address grantee,
        bytes32 dataCategory,
        uint64 expiry
    ) external returns (bytes32 attestationId) {
        require(grantee != address(0), "grantee cannot be zero address");
        require(expiry > block.timestamp, "expiry must be in the future");

        uint256 nonce = _nonces[msg.sender]++;
        attestationId = keccak256(
            abi.encodePacked(msg.sender, grantee, dataCategory, expiry, nonce)
        );

        attestations[attestationId] = Attestation({
            subject: msg.sender,
            grantee: grantee,
            dataCategory: dataCategory,
            expiry: expiry,
            revoked: false,
            grantedAt: uint64(block.timestamp),
            revokedAt: 0
        });

        emit AccessGranted(attestationId, msg.sender, grantee, dataCategory, expiry);
    }

    /// @notice The subject who created an attestation revokes it. Nobody
    /// else - not the grantee, not NewCo - can revoke someone else's grant.
    /// This is what makes revocation a real right rather than a request.
    function revoke(bytes32 attestationId) external {
        Attestation storage a = attestations[attestationId];
        require(a.subject != address(0), "attestation does not exist");
        require(a.subject == msg.sender, "only the subject can revoke their own grant");
        require(!a.revoked, "already revoked");

        a.revoked = true;
        a.revokedAt = uint64(block.timestamp);

        emit AccessRevoked(attestationId, msg.sender, a.revokedAt);
    }

    /// @notice Anyone can check whether a grant is currently active - this
    /// is the function every downstream consumer (including NewCo's own
    /// KMS gateway) MUST call before acting on gated data.
    function isAccessActive(bytes32 attestationId) public view returns (bool) {
        Attestation storage a = attestations[attestationId];
        if (a.subject == address(0)) return false; // never existed
        if (a.revoked) return false;
        if (block.timestamp >= a.expiry) return false;
        return true;
    }
}
