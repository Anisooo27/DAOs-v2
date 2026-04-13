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
    treasuryAddress: null
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const navigate = useNavigate();

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
      
      if (!provider) throw new Error("Wallet provider not found");
      const signer = await provider.getSigner();
      
      let finalCalldata = calldata;
      let finalValue = value;

      if (isTreasuryTarget) {
        if (!recipient || !amount) {
          throw new Error("Recipient and Amount are required for Treasury withdrawals");
        }
        
        // Explicitly following the requested encoding pattern
        const iface = new ethers.Interface([
          "function withdrawETH(address payable to, uint256 amount)"
        ]);
        
        finalCalldata = iface.encodeFunctionData("withdrawETH", [
          recipient,
          ethers.parseEther(amount.toString())
        ]);
        
        finalValue = "0"; // Withdrawals from Treasury are triggered by a 0-value call to withdrawETH
        
        console.log("Treasury Withdrawal Encoded:", {
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
          recipient: isTreasuryTarget ? recipient : undefined,
          amount: isTreasuryTarget ? amount : undefined,
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

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Propose Action</h1>
        <p className="page-subtitle">Draft a new proposal for the DAO to vote on, detailing payload targets and descriptions.</p>
      </div>

      <div className="glass-panel">
        <form onSubmit={handleCreateProposal}>
          <div className="form-group">
            <label className="form-label" htmlFor="description">Proposal Description</label>
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

          <div className="form-group mt-4">
            <label className="form-label" htmlFor="target">Target Contract Address</label>
            <input
              id="target"
              type="text"
              className="form-input"
              placeholder="0x..."
              value={targetAddress}
              onChange={(e) => setTargetAddress(e.target.value)}
              required
              style={isTreasuryTarget ? { borderColor: 'var(--accent-primary)', boxShadow: '0 0 10px rgba(0, 255, 136, 0.2)' } : {}}
            />
            {isTreasuryTarget && (
              <div className="mt-2 text-xs flex items-center gap-1" style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                <Wallet size={12} />
                TREASURY DETECTED — WITHDRAWAL MODE ENABLED
              </div>
            )}
          </div>

          {isTreasuryTarget ? (
            <div className="glass-panel mt-6" style={{ border: '1px solid var(--accent-primary)', background: 'rgba(0, 255, 136, 0.05)', padding: '20px' }}>
              <div className="flex items-center gap-2 mb-4">
                <div style={{ padding: '6px', background: 'var(--accent-primary)', borderRadius: '4px', color: '#000' }}>
                  <Send size={14} />
                </div>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--accent-primary)' }}>Treasury Withdrawal Configuration</h3>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="recipient">Recipient Address</label>
                  <input
                    id="recipient"
                    type="text"
                    className="form-input"
                    placeholder="0x..."
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    required
                  />
                  <p className="text-muted mt-1" style={{ fontSize: '0.75rem' }}>The wallet address that will receive the ETH.</p>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="amount">Withdrawal Amount (ETH)</label>
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
                      style={{ paddingRight: '40px' }}
                    />
                    <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', opacity: 0.5 }}>ETH</span>
                  </div>
                  <p className="text-muted mt-1" style={{ fontSize: '0.75rem' }}>Amount to transfer from the DAO Treasury.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="form-group mt-4" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
              <div>
                <label className="form-label" htmlFor="value">Value (ETH)</label>
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
                <label className="form-label" htmlFor="calldata">Calldata</label>
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

          <div className="glass-panel mt-4 mb-4" style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '16px' }}>
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
            style={{ width: '100%', padding: '14px' }}
            disabled={isSubmitting || !address}
          >
            <Send size={18} />
            {isSubmitting ? 'Submitting to Network...' : 'Submit Proposal'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default CreateProposal;
