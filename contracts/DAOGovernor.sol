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

// ---------------- ERC20 (for balanceOf) ----------------
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DAOGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    mapping(uint256 => bytes32) public proposalDescriptionHashes;

    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public hasRevealed;

    event VoteCommitted(uint256 indexed proposalId, address indexed voter, bytes32 commitment);
    event VoteRevealed(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight);
    event RevealRejected(uint256 indexed proposalId, address indexed voter, string reason);
    event VoteRejected(uint256 indexed proposalId, address indexed voter, string reason);

    struct ProposalDetails {
        uint256 proposalId;
        address proposer;
        bytes32 descriptionHash;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        ProposalState state;
    }

    constructor(
        IVotes _token,
        TimelockController timelock
    )
        Governor("MyDAO")
        GovernorSettings(
            1,      // voting delay (blocks)
            50,     // voting period (~10 mins @ 12s/block, but much faster on local)
            0       // proposal threshold
        )
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(0) // 0% quorum: balance-based, no checkpoint quorum needed
        GovernorTimelockControl(timelock)
    {}

    function getProposalDetails(uint256 proposalId) public view returns (ProposalDetails memory) {
        (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes) = proposalVotes(proposalId);
        return ProposalDetails({
            proposalId: proposalId,
            proposer: proposalProposer(proposalId),
            descriptionHash: proposalDescriptionHashes[proposalId],
            forVotes: forVotes,
            againstVotes: againstVotes,
            abstainVotes: abstainVotes,
            state: state(proposalId)
        });
    }

    // --------------------------------------------------
    // Balance-Based Voting Power
    // --------------------------------------------------
    // Override _getVotes() so the Governor reads each voter's current
    // token balance instead of delegation checkpoints.
    // blockNumber is intentionally ignored — we use the live balance.
    function _getVotes(
        address account,
        uint256 /* blockNumber */,
        bytes memory /* params */
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        return IERC20(address(token)).balanceOf(account);
    }

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
        require(
            IERC20(address(token)).balanceOf(msg.sender) > 0,
            "No GOV tokens: wallet must hold GOV tokens to propose"
        );
        uint256 proposalId = super.propose(targets, values, calldatas, description);
        proposalDescriptionHashes[proposalId] = keccak256(bytes(description));
        return proposalId;
    }

    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    ) internal override(Governor) returns (uint256) {
        require(
            IERC20(address(token)).balanceOf(account) > 0,
            "No GOV tokens: wallet must hold GOV tokens to vote"
        );
        return super._castVote(proposalId, account, support, reason, params);
    }

    function commitVote(uint256 proposalId, bytes32 commitment) public {
        require(state(proposalId) == ProposalState.Active, "Governor: vote not currently active");
        if (commitments[proposalId][msg.sender] != bytes32(0)) {
            emit VoteRejected(proposalId, msg.sender, "duplicate commit");
            return;
        }
        
        require(
            IERC20(address(token)).balanceOf(msg.sender) > 0,
            "No GOV tokens: wallet must hold GOV tokens to vote"
        );

        commitments[proposalId][msg.sender] = commitment;
        emit VoteCommitted(proposalId, msg.sender, commitment);
    }

    function revealVote(uint256 proposalId, uint8 support, string memory secret) public {
        require(state(proposalId) == ProposalState.Active, "Governor: vote not currently active");
        
        if (hasRevealed[proposalId][msg.sender]) {
            emit RevealRejected(proposalId, msg.sender, "duplicate reveal");
            return;
        }
        
        bytes32 storedCommitment = commitments[proposalId][msg.sender];
        require(storedCommitment != bytes32(0), "No commitment found");

        bytes32 expectedCommitment = keccak256(abi.encodePacked(msg.sender, proposalId, support, secret));
        
        if (expectedCommitment != storedCommitment) {
            emit RevealRejected(proposalId, msg.sender, "invalid secret");
            return;
        }
        
        hasRevealed[proposalId][msg.sender] = true;
        uint256 weight = _castVote(proposalId, msg.sender, support, "");
        emit VoteRevealed(proposalId, msg.sender, support, weight);
    }
}
