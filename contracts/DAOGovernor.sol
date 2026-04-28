// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ---------------- Core ----------------
import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/IGovernor.sol";

// ---------------- Extensions ----------------
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";

// ---------------- Timelock ----------------
import "@openzeppelin/contracts/governance/TimelockController.sol";

contract DAOGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(
        IVotes token,
        TimelockController timelock
    )
        Governor("MyDAO")
        GovernorSettings(
            1,      // voting delay (blocks)
            50,     // voting period (~10 mins @ 12s/block, but much faster on local)
            0       // proposal threshold
        )
        GovernorVotes(token)
        GovernorVotesQuorumFraction(10) // 10% quorum: at least 10% of total GOV supply must vote
        GovernorTimelockControl(timelock)
    {}

    // --------------------------------------------------
    // Required overrides (OpenZeppelin v5)
    // --------------------------------------------------

    function votingDelay()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(IGovernor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(IGovernor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    // --------------------------------------------------
    // Majority Vote Enforcement
    // --------------------------------------------------
    // Override _voteSucceeded to require STRICT majority:
    //   For votes must STRICTLY exceed Against votes.
    //   A tie (For == Against) is treated as Defeated.
    // GovernorCountingSimple already tracks forVotes/againstVotes;
    // we expose them via proposalVotes() and use them here explicitly.
    function _voteSucceeded(uint256 proposalId)
        internal
        view
        override(Governor, GovernorCountingSimple)
        returns (bool)
    {
        (uint256 againstVotes, uint256 forVotes, ) = proposalVotes(proposalId);
        return forVotes > againstVotes;
    }

    // --------------------------------------------------
    // State — explicit majority + quorum enforcement
    // --------------------------------------------------
    // GovernorTimelockControl.state() wraps Governor.state() and adds Queued(5)
    // and Executed(7) states for proposals that entered the Timelock.
    // We call super.state() to preserve those states, then add an explicit
    // belt-and-suspenders check: if the chain says Succeeded(4) but our strict
    // majority or quorum requirements are NOT met, we override to Defeated(3).
    //
    // In practice super.state() already calls _voteSucceeded() + quorumReached()
    // because we override _voteSucceeded. This guard makes the logic unambiguous
    // and protects against any future inheritance changes.
    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        ProposalState s = super.state(proposalId);

        // Only intervene for Succeeded(4). Queued(5) and Executed(7) come from
        // the Timelock and must not be overridden — they are post-Succeeded states.
        if (s == ProposalState.Succeeded) {
            if (!_voteSucceeded(proposalId) || !_quorumReached(proposalId)) {
                return ProposalState.Defeated;
            }
        }
        return s;
    }

    // --------------------------------------------------
    // Execute — guard against executing a Defeated proposal
    // --------------------------------------------------
    function _execute(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
    {
        // Re-verify state immediately before execution.
        // state() already returns Defeated if Against >= For or quorum not met,
        // so this guard is a belt-and-suspenders safety check.
        ProposalState currentState = state(proposalId);
        require(
            currentState != ProposalState.Defeated,
            "Proposal defeated - majority voted Against."
        );
        super._execute(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    )
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    {
        return super._cancel(
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override(Governor, IGovernor) returns (uint256) {
        require(token.getVotes(msg.sender) > 0, "No voting power: wallet has not delegated");
        return super.propose(targets, values, calldatas, description);
    }

    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    ) internal override(Governor) returns (uint256) {
        require(token.getVotes(account) > 0, "No voting power: wallet has not delegated");
        return super._castVote(proposalId, account, support, reason, params);
    }
}
