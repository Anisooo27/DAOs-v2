import { useState, useEffect } from 'react';
import { Send, FileText, Wallet, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';

const CreateProposal = ({ provider, address }) => {
  const [description, setDescription] = useState('');
  const [targetAddress, setTargetAddress] = useState('');
  const [value, setValue] = useState('0');
  const [calldata, setCalldata] = useState('0x'); // Fallback signature hex
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [contractConfig, setContractConfig] = useState({
    governorAddress: null,
    treasuryAddress: null,
    tokenAddress: null
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [delegationStatus, setDelegationStatus] = useState(null); // null = checking, true/false = result
  const [votingPower, setVotingPower] = useState(null);           // null = checking, '0' = none
  const [targetDelegationStatus, setTargetDelegationStatus] = useState(null);
  const [recipientDelegationStatus, setRecipientDelegationStatus] = useState(null);
  const [isCheckingProposer, setIsCheckingProposer] = useState(false);
  const [isCheckingTarget, setIsCheckingTarget] = useState(false);
  const [isCheckingRecipient, setIsCheckingRecipient] = useState(false);
  
  const navigate = useNavigate();

  // --- Effect 1: Single enriched delegation check (MongoDB + on-chain votes) ---
  // The /delegation/:address endpoint now returns both the MongoDB record AND
  // on-chain getVotes() in one call, eliminating the tokenAddress race condition.
  useEffect(() => {
    const checkDelegation = async () => {
      if (!address) {
        setDelegationStatus(null);
        setVotingPower(null);
        return;
      }
      try {
        setIsCheckingProposer(true);
        const res = await fetch(`http://localhost:5000/delegation/${address}`);
        if (res.ok) {
          const data = await res.json();
          setDelegationStatus(data.delegated);
          // Use on-chain votes from the backend (authoritative) if available
          if (data.onChainVotes !== undefined) {
            setVotingPower(data.onChainVotes);
            console.log(`[proposer] MongoDB delegated: ${data.delegated} | On-chain votes: ${data.onChainVotes} | hasVotingPower: ${data.hasVotingPower}`);
          }
        } else {
          setDelegationStatus(false);
          setVotingPower('0');
        }
      } catch (err) {
        console.error('[proposer] Delegation check failed:', err);
        setDelegationStatus(false);
        setVotingPower('0');
      } finally {
        setIsCheckingProposer(false);
      }
    };
    checkDelegation();
  }, [address]);

  // --- Effect 2: Supplement with direct on-chain getVotes() when tokenAddress available ---
  // This runs in parallel as a cross-check / fallback for when the backend RPC is slow.
  useEffect(() => {
    const fetchVotingPower = async () => {
      if (!address || !contractConfig.tokenAddress || !provider) return;
      try {
        const signer = await provider.getSigner();
        const tokenContract = new ethers.Contract(contractConfig.tokenAddress, [
          'function getVotes(address account) view returns (uint256)'
        ], signer);
        const votes = await tokenContract.getVotes(address);
        setVotingPower(votes.toString());
        console.log(`[proposer] Direct getVotes(): ${ethers.formatEther(votes)} GOV`);
      } catch (err) {
        console.warn('[proposer] Direct getVotes() failed (non-critical):', err.message);
      }
    };
    fetchVotingPower();
  }, [address, contractConfig.tokenAddress, provider]);

  useEffect(() => {
    const fetchConfig = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000); // Wait 1s max for sync

      try {
        const response = await fetch('http://localhost:5000/config/contract', { signal: controller.signal });
        const data = await response.json();
        clearTimeout(timeoutId);
        console.log("[sync] Contract configuration updated from backend:", data);
        setContractConfig(data);
      } catch (error) {
        clearTimeout(timeoutId);
        console.info("[sync] Background sync unavailable, using defaults.");
      }
    };
    fetchConfig();
  }, []);

  const isTreasuryTarget = contractConfig.treasuryAddress && targetAddress.trim().toLowerCase() === contractConfig.treasuryAddress.toLowerCase();
  const isWithdrawalMode = isTreasuryTarget || targetDelegationStatus === true;

  // 1. Check Target Delegation (to determine if Withdrawal Mode should be ON)
  useEffect(() => {
    const checkTargetDelegation = async () => {
      const trimmed = targetAddress.trim();
      if (!trimmed || !ethers.isAddress(trimmed) || trimmed.toLowerCase() === contractConfig.treasuryAddress?.toLowerCase()) {
        setTargetDelegationStatus(null);
        return;
      }
      try {
        setIsCheckingTarget(true);
        const res = await fetch(`http://localhost:5000/delegation/${trimmed}`);
        if (res.ok) {
          const data = await res.json();
          setTargetDelegationStatus(data.delegated);
        } else {
          setTargetDelegationStatus(false);
        }
      } catch (err) {
        console.error("Error checking target delegation:", err);
        setTargetDelegationStatus(false);
      } finally {
        setIsCheckingTarget(false);
      }
    };
    const timeoutId = setTimeout(checkTargetDelegation, 500);
    return () => clearTimeout(timeoutId);
  }, [targetAddress, contractConfig.treasuryAddress]);

  // 2. Check Recipient (informational only — delegation NOT required for recipients)
  // We still query the backend to show a helpful tooltip, but a missing record
  // DOES NOT block submission. Recipients can be any valid address (EOA, Treasury, etc.)
  useEffect(() => {
    const checkRecipientInfo = async () => {
      const trimmed = recipient.trim();
      if (!isWithdrawalMode || !trimmed || !ethers.isAddress(trimmed)) {
        setRecipientDelegationStatus(null);
        return;
      }
      try {
        setIsCheckingRecipient(true);
        // Normalize address before lookup to avoid checksum mismatches
        const normalized = ethers.getAddress(trimmed);
        const res = await fetch(`http://localhost:5000/delegation/${normalized}`);
        if (res.ok) {
          const data = await res.json();
          // Store full enriched data; true = has voting power, false = no record/no power
          setRecipientDelegationStatus(data.hasVotingPower === true ? 'has-power' : data.mongoRecordExists ? 'record-only' : 'none');
        } else {
          setRecipientDelegationStatus('none');
        }
      } catch (err) {
        console.warn('Recipient info check failed (non-critical):', err.message);
        setRecipientDelegationStatus('none');
      } finally {
        setIsCheckingRecipient(false);
      }
    };
    const timeoutId = setTimeout(checkRecipientInfo, 500);
    return () => clearTimeout(timeoutId);
  }, [recipient, isWithdrawalMode]);

  useEffect(() => {
    const trimmedInput = targetAddress.trim().toLowerCase();
    const expectedTreasury = contractConfig.treasuryAddress?.toLowerCase();

    if (isTreasuryTarget) {
      console.log("Withdrawal Mode active - Treasury matched:", { 
        input: targetAddress, 
        isTreasuryTarget: true 
      });
    } else if (targetAddress.trim() !== '') {
      console.log("Target Address match status:", {
        input: trimmedInput,
        expected: expectedTreasury,
        isTreasuryTarget: false
      });
    }
  }, [isTreasuryTarget, targetAddress, contractConfig.treasuryAddress]);

  const handleCreateProposal = async (e) => {
    e.preventDefault();
    if (!address) {
      alert("Please connect your wallet first");
      return;
    }

    try {
      setIsSubmitting(true);
      
      if (isWithdrawalMode) {
        // Recipient only needs to be a valid address — NO delegation required.
        // Governance policy: only the proposer must be delegated.
        if (!ethers.isAddress(recipient)) {
          throw new Error('Invalid recipient address');
        }
        if (!amount || parseFloat(amount) <= 0) {
          throw new Error('A positive amount is required for withdrawals');
        }
      } else {
        // Not in withdrawal mode — check target is valid
        if (targetAddress.trim() !== '' && !isTreasuryTarget && targetDelegationStatus === false) {
          throw new Error('Target address is not delegated and is not the Treasury.');
        }
      }
      
      if (!provider) throw new Error("Wallet provider not found");
      const signer = await provider.getSigner();
      
      let finalCalldata = calldata;
      let finalValue = value;

      if (isWithdrawalMode) {
        if (!recipient || !amount) {
          throw new Error("Recipient and Amount are required for withdrawals");
        }
        
        // Explicitly following the requested encoding pattern
        const iface = new ethers.Interface([
          "function withdrawETH(address payable to, uint256 amount)"
        ]);
        
        finalCalldata = iface.encodeFunctionData("withdrawETH", [
          recipient,
          ethers.parseEther(amount.toString())
        ]);
        
        finalValue = "0"; 
        
        console.log("Withdrawal Encoded:", {
          target: targetAddress.trim(),
          recipient,
          amount,
          calldata: finalCalldata
        });
      }

      const message = JSON.stringify({
        proposalDescription: description,
        targetContract: targetAddress.trim(),
        value: finalValue.toString(),
        calldata: finalCalldata
      });
      
      const signature = await signer.signMessage(message);

      // --- NEW: Trigger On-Chain Propose ---
      console.log("Registering proposal on-chain via Governor:", contractConfig.governorAddress);
      
      const GOVERNOR_ABI = [
        "function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) public returns (uint256)",
        "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)"
      ];
      
      const governorContract = new ethers.Contract(contractConfig.governorAddress, GOVERNOR_ABI, signer);
      
      const proposeTx = await governorContract.propose(
        [targetAddress.trim()],
        [ethers.parseEther(finalValue.toString())],
        [finalCalldata],
        description
      );
      
      console.log("Transaction sent:", proposeTx.hash);
      const receipt = await proposeTx.wait();
      console.log("Transaction receipt received:", { 
        logsCount: receipt.logs.length,
        status: receipt.status,
        blockHash: receipt.blockHash
      });
      
      // Extract proposalId from ProposalCreated event
      const governorIface = new ethers.Interface(GOVERNOR_ABI);
      let onChainProposalId;
      
      // Calculate the topic0 hash for ProposalCreated to ensure we find it even if parsing fails
      // Signature: ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)
      const proposalCreatedTopic = ethers.id("ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)");
      
      console.log("Scanning transaction logs for ProposalCreated event...", { expectedTopic: proposalCreatedTopic });
      
      for (const [index, log] of receipt.logs.entries()) {
        const isFromGovernor = log.address.toLowerCase() === contractConfig.governorAddress.toLowerCase();
        const isTargetTopic = log.topics[0] === proposalCreatedTopic;
        
        console.log(`[log #${index}] Address: ${log.address} | Match: ${isTargetTopic}`);

        try {
          // Attempt standard parsing first
          const parsed = governorIface.parseLog(log);
          if (parsed && parsed.name === 'ProposalCreated') {
            onChainProposalId = parsed.args[0].toString();
            console.log(`[on-chain] STANDARD PARSE SUCCESS in log #${index}:`, onChainProposalId);
            break;
          }
        } catch (e) {
          // Fallback: If topics match but parsing failed (likely due to minor ABI mismatch)
          if (isTargetTopic) {
            console.warn(`[on-chain] Topic match in log #${index} but parseLog failed. Attempting manual extraction...`);
            try {
              // The proposalId is the first parameter (uint256) in the data/topics according to OZ
              // For indexed events, it's in topics; ProposalCreated parameters are NOT indexed.
              // So it's in the data section.
              const decoded = governorIface.decodeEventLog("ProposalCreated", log.data, log.topics);
              onChainProposalId = decoded[0].toString();
              console.log(`[on-chain] MANUAL DECODE SUCCESS in log #${index}:`, onChainProposalId);
              break;
            } catch (manualError) {
              console.error(`[on-chain] Manual extraction failed in log #${index}:`, manualError.message);
            }
          }
        }
      }
      
      if (!onChainProposalId) {
        console.error("Exhausted all logs. Printing all topics for rescue diagnostics:");
        receipt.logs.forEach((l, i) => console.log(`Log #${i} Topic0: ${l.topics[0]} Address: ${l.address}`));
        throw new Error("ProposalCreated event not found. Check browser console for [diag] logs.");
      }
      
      console.log("On-chain Proposal Created with ID:", onChainProposalId);

      const response = await fetch('http://localhost:5000/propose', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          proposalId: onChainProposalId,
          proposerAddress: address,
          description,
          target: targetAddress.trim(),
          value: finalValue.toString(),
          calldata: finalCalldata,
          recipient: isWithdrawalMode ? recipient : undefined,
          amount: isWithdrawalMode ? amount : undefined,
          signature
        })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save proposal to backend');
      }
      
      console.log("Proposal Created:", data);
      alert("Proposal Submitted Successfully!");
      
      // Redirect to cast vote using the returned proposal ID
      navigate(`/cast-vote?proposalId=${data.proposalId}`);
    } catch (error) {
      console.error("Error creating proposal:", error);
      alert(error.message || "Failed to create proposal");
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Validation Booleans ---
  // proposerChecking: true while async checks are in flight
  const proposerChecking = isCheckingProposer || (!!address && delegationStatus === null) || (!!address && !!contractConfig.tokenAddress && votingPower === null);

  // proposerOk: ONLY check the connected wallet has on-chain voting power.
  // This is the single gating requirement for proposal creation.
  const proposerOk = !!address && delegationStatus === true && votingPower !== null && votingPower !== '0';

  // targetOk: Treasury always valid; other addresses must have a delegation record.
  const descriptionOk = description.trim() !== '';
  const targetFieldOk = targetAddress.trim() !== '' && (isTreasuryTarget || targetDelegationStatus === true);
  const targetOk = descriptionOk && targetFieldOk;

  // recipientOk: only needs a valid Ethereum address + positive amount.
  // Delegation is NOT required — any address can receive funds.
  const recipientOk = !isWithdrawalMode || (
    ethers.isAddress(recipient.trim()) &&
    !!amount && parseFloat(amount) > 0
  );

  const isAnyChecking = proposerChecking || isCheckingTarget || isCheckingRecipient;
  const isFinalReady = proposerOk && targetOk && recipientOk;

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Propose Action</h1>
        <p className="page-subtitle">Draft a new proposal for the DAO to vote on, detailing payload targets and descriptions.</p>
      </div>

      <div className="glass-panel" style={{ padding: '32px' }}>
        <form onSubmit={handleCreateProposal} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="description" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Proposal Description</label>
            <textarea
              id="description"
              className="form-input"
              rows="4"
              placeholder="# Markdown supported&#10;Describe the rationale and outcome of this proposal..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            ></textarea>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="target" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Target Contract Address</label>
            <input
              id="target"
              type="text"
              className="form-input"
              placeholder="0x..."
              value={targetAddress}
              onChange={(e) => setTargetAddress(e.target.value)}
              required
              style={isWithdrawalMode ? { borderColor: 'var(--accent-primary)', boxShadow: '0 0 10px rgba(0, 255, 136, 0.2)', padding: '12px' } : { padding: '12px' }}
            />
            {isWithdrawalMode && (
              <div className="mt-2 text-xs flex items-center gap-1" style={{ color: 'var(--accent-primary)', fontWeight: 600, marginTop: '8px' }}>
                <Wallet size={12} />
                {isTreasuryTarget ? 'TREASURY DETECTED — WITHDRAWAL MODE ENABLED' : 'DELEGATED TARGET DETECTED — WITHDRAWAL MODE ENABLED'}
              </div>
            )}
            {!isWithdrawalMode && targetAddress.trim() !== '' && !isCheckingTarget && targetDelegationStatus === false && (
              <div style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '8px', fontWeight: 500 }}>
                ⚠️ Target address not delegated.
              </div>
            )}
          </div>

          {isWithdrawalMode ? (
            <div className="glass-panel mt-6" style={{ border: '1px solid var(--accent-primary)', background: 'rgba(0, 255, 136, 0.05)', padding: '28px' }}>
              <div className="flex items-center gap-2 mb-6">
                <div style={{ padding: '6px', background: 'var(--accent-primary)', borderRadius: '4px', color: '#000' }}>
                  <Send size={14} />
                </div>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--accent-primary)' }}>Withdrawal Configuration</h3>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="recipient" style={{ marginBottom: '10px', display: 'block', fontWeight: 600 }}>Recipient Address</label>
                  <input
                    id="recipient"
                    type="text"
                    className="form-input"
                    placeholder="0x..."
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    required
                    style={{ padding: '12px' }}
                  />
                  {recipientDelegationStatus === 'none' && !isCheckingRecipient && recipient.trim() !== '' ? (
                    <div style={{ color: 'var(--accent-secondary)', fontSize: '0.78rem', marginTop: '6px' }}>
                      ℹ️ No delegation record — that's fine. Any valid address can receive funds.
                    </div>
                  ) : recipientDelegationStatus === 'has-power' ? (
                    <div style={{ color: 'var(--accent-primary)', fontSize: '0.78rem', marginTop: '6px' }}>
                      ✅ Recipient holds GOV voting power.
                    </div>
                  ) : (
                    <p className="text-muted mt-2" style={{ fontSize: '0.75rem' }}>The wallet address that will receive the ETH.</p>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="amount" style={{ marginBottom: '10px', display: 'block', fontWeight: 600 }}>Withdrawal Amount (ETH)</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="amount"
                      type="number"
                      step="0.01"
                      className="form-input"
                      placeholder="1.0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                      style={{ paddingRight: '44px', paddingLeft: '14px', height: '48px' }}
                    />
                    <span style={{ position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.85rem', opacity: 0.6, fontWeight: 600 }}>ETH</span>
                  </div>
                  <p className="text-muted mt-2" style={{ fontSize: '0.75rem' }}>Amount to transfer from the target contract.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              <div>
                <label className="form-label" htmlFor="value" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Value (ETH)</label>
                <input
                  id="value"
                  type="number"
                  step="0.01"
                  className="form-input"
                  placeholder="0.00"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <div>
                <label className="form-label" htmlFor="calldata" style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Calldata</label>
                <input
                  id="calldata"
                  type="text"
                  className="form-input"
                  placeholder="0x..."
                  value={calldata}
                  onChange={(e) => setCalldata(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="glass-panel mt-2 mb-2" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '16px' }}>
            <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--accent-secondary)' }}>
              <FileText size={16} /> 
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Proposal Lifecycle</span>
            </div>
            <p className="text-muted" style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
              Creating a proposal generates a unique Proposal ID. Voting is off-chain, requiring a minimum active threshold before it can be queued for on-chain execution.
            </p>
          </div>

          <button 
            type="submit" 
            className="btn btn-primary" 
            style={{ 
              width: '100%', 
              padding: '16px',
              fontSize: '1.05rem', 
              opacity: !isFinalReady || isSubmitting ? 0.6 : 1,
              marginTop: '12px'
            }}
            disabled={isSubmitting || !isFinalReady || isAnyChecking}
          >
            <Send size={18} />
            {isSubmitting ? 'Submitting...'
              : isAnyChecking ? 'Verifying Details...'
              : !address ? 'Please connect a wallet to continue'
              : (delegationStatus === false) ? 'You must delegate before proposing'
              : (votingPower === '0') ? 'You must delegate before proposing'
              : !descriptionOk ? 'Enter Proposal Description'
              : !targetAddress.trim() ? 'Enter Target Contract Address'
              : (!isWithdrawalMode && targetAddress.trim() !== '' && targetDelegationStatus === false) ? 'Target address not delegated'
              : (isWithdrawalMode && (!recipient.trim() || !ethers.isAddress(recipient.trim()))) ? 'Enter a valid Recipient Address'
              : (isWithdrawalMode && (!amount || parseFloat(amount) <= 0)) ? 'Enter Withdrawal Amount'
              : 'Submit Proposal'}
          </button>

          {/* --- Validation Status Dashboard --- */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '14px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', textAlign: 'center', gap: '8px' }}>
              <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'help' }}
                title={proposerOk ? 'Proposer is delegated with active voting power.' : !address ? 'No wallet connected.' : (delegationStatus === false) ? 'Not delegated in MongoDB. Go to Dashboard and click "Delegate Votes".' : (votingPower === '0') ? 'On-chain voting power is 0. Delegate your tokens first.' : 'Checking delegation...'}
              >
                <span style={{ fontSize: '1.1rem' }}>{proposerChecking ? '⏳' : proposerOk ? '✅' : '❌'}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.65, color: proposerOk ? 'var(--accent-primary)' : proposerChecking ? 'inherit' : 'var(--danger)' }}>Proposer</span>
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'help' }}
                title={targetOk ? (isTreasuryTarget ? 'Treasury is always a valid target.' : 'Target contract is delegated.') : !descriptionOk ? 'Enter a proposal description first.' : !targetAddress.trim() ? 'Enter a target contract address.' : (targetDelegationStatus === false ? 'Target address is not delegated.' : 'Verifying target...')}
              >
                <span style={{ fontSize: '1.1rem' }}>{isCheckingTarget ? '⏳' : targetOk ? '✅' : '❌'}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.65, color: targetOk ? 'var(--accent-primary)' : 'var(--danger)' }}>Target</span>
              </div>
              <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'help' }}
                title={
                  !isWithdrawalMode
                    ? 'No recipient required for this target.'
                    : !recipient.trim() || !ethers.isAddress(recipient.trim())
                    ? 'Enter a valid recipient address (any Ethereum address is accepted).'
                    : !amount || parseFloat(amount) <= 0
                    ? 'Enter a positive withdrawal amount.'
                    : recipientDelegationStatus === 'has-power'
                    ? 'Recipient has on-chain voting power (GOV delegated).'
                    : recipientDelegationStatus === 'record-only'
                    ? 'Recipient has a delegation record but 0 on-chain votes. This is OK — recipients do not need to be delegated.'
                    : 'Valid recipient address. Note: Recipients do not need to hold GOV tokens.'
                }
              >
                <span style={{ fontSize: '1.1rem' }}>{isCheckingRecipient ? '⏳' : recipientOk ? '✅' : (!isWithdrawalMode ? '➖' : '❌')}</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.65, color: recipientOk ? 'var(--accent-primary)' : (!isWithdrawalMode ? 'inherit' : 'var(--danger)') }}>Recipient</span>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateProposal;
