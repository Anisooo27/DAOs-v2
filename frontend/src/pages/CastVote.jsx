import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ethers } from 'ethers';
import { CheckCircle, XCircle, MinusCircle, ShieldCheck, Lock, Unlock } from 'lucide-react';
import config from '../config';

const GOVERNOR_ABI = [
  'function commitVote(uint256 proposalId, bytes32 commitment) public',
  'function revealVote(uint256 proposalId, uint8 support, string memory secret) public',
  'function commitments(uint256 proposalId, address voter) public view returns (bytes32)',
  'function hasRevealed(uint256 proposalId, address account) public view returns (bool)',
  'function state(uint256 proposalId) public view returns (uint8)',
  'function hasVoted(uint256 proposalId, address account) public view returns (bool)',
  'event VoteCommitted(uint256 indexed proposalId, address indexed voter, bytes32 commitment)',
  'event VoteRevealed(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight)',
  'event RevealRejected(uint256 indexed proposalId, address indexed voter, string reason)',
  'event VoteRejected(uint256 indexed proposalId, address indexed voter, string reason)'
];

const CastVote = ({ provider, address }) => {
  const [searchParams] = useSearchParams();
  const initialProposalId = searchParams.get('proposalId') || '';

  const [proposalId, setProposalId] = useState(initialProposalId);
  const [choice, setChoice]         = useState(null);
  const [secret, setSecret]         = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus]         = useState(null);
  const [govBalance, setGovBalance] = useState(null);
  const [proposalState, setProposalState] = useState(null);
  const [isAdvancing, setIsAdvancing] = useState(false);
  
  const [hasCommitted, setHasCommitted] = useState(false);
  const [hasRevealed, setHasRevealed] = useState(false);

  useEffect(() => {
    const fetchStatus = async () => {
      if (!address) return;
      try {
        const memRes = await fetch(`http://localhost:5000/membership/${address}`);
        if (memRes.ok) {
          const memData = await memRes.json();
          setGovBalance(memData.govBalance ?? '0');
        }

        const configRes = await fetch('http://localhost:5000/config/contract');
        const configData = await configRes.json();
        if (provider && configData.tokenAddress) {
          const signer = await provider.getSigner();
          const tokenContract = new ethers.Contract(configData.tokenAddress, [
            'function balanceOf(address account) view returns (uint256)'
          ], signer);
          const bal = await tokenContract.balanceOf(address);
          setGovBalance(bal.toString());
        }
      } catch (err) {
        console.error('Error fetching voting status:', err);
      }
    };
    fetchStatus();
  }, [address, provider]);

  useEffect(() => {
    const fetchProposalState = async () => {
      if (!provider || !proposalId.trim() || !address) {
        setProposalState(null);
        setHasCommitted(false);
        setHasRevealed(false);
        return;
      }
      try {
        const configRes = await fetch('http://localhost:5000/config/contract');
        const configData = await configRes.json();
        const governorContract = new ethers.Contract(configData.governorAddress, GOVERNOR_ABI, provider);
        const s = await governorContract.state(proposalId.trim());
        setProposalState(Number(s));
        
        const comm = await governorContract.commitments(proposalId.trim(), address);
        setHasCommitted(comm !== ethers.ZeroHash);
        
        const rev = await governorContract.hasRevealed(proposalId.trim(), address);
        setHasRevealed(rev);
      } catch (err) {
        setProposalState(null);
        console.warn('Could not fetch proposal state:', err.message);
      }
    };
    fetchProposalState();
    const interval = setInterval(fetchProposalState, 5000);
    return () => clearInterval(interval);
  }, [proposalId, provider, address]);

  const OPTIONS = [
    { id: 0, label: 'Against', icon: XCircle,      color: 'var(--danger)'     },
    { id: 1, label: 'For',     icon: CheckCircle,   color: 'var(--success)'    },
    { id: 2, label: 'Abstain', icon: MinusCircle,   color: 'var(--text-muted)' }
  ];

  const handleAdvanceToVoting = async () => {
    try {
      setIsAdvancing(true);
      setStatus(null);
      const configRes = await fetch('http://localhost:5000/config/contract');
      const configData = await configRes.json();
      const governorContract = new ethers.Contract(configData.governorAddress, [
        "function votingDelay() public view returns (uint256)"
      ], provider);
      
      const vDelay = await governorContract.votingDelay();
      
      const res = await fetch('http://localhost:5000/rpc/mine', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: Number(vDelay) + 1 })
      });
      if (!res.ok) throw new Error('Failed to mine blocks to advance to voting');
      
      setStatus({ type: 'success', message: 'Blocks mined. Voting is now active!' });
      
      setProposalState(1);
    } catch (err) {
      console.error('[advance]', err);
      setStatus({ type: 'error', message: err.message });
    } finally {
      setIsAdvancing(false);
    }
  };

  const handleCommitVote = async () => {
    if (!address) { alert('Please connect your wallet first.'); return; }
    if (!proposalId.trim() || choice === null || !secret.trim()) {
      alert('Please enter a Proposal ID, select a choice, and provide a secret phrase.');
      return;
    }

    try {
      setIsProcessing(true);
      setStatus(null);

      const signer = await provider.getSigner();
      const configRes = await fetch('http://localhost:5000/config/contract');
      const configData = await configRes.json();
      
      const governorContract = new ethers.Contract(configData.governorAddress, GOVERNOR_ABI, signer);
      
      const state = await governorContract.state(proposalId.trim());
      if (Number(state) === 0) {
        throw new Error("Voting not yet active, advance blocks.");
      } else if (Number(state) !== 1) {
        throw new Error(`Voting is not active for this proposal. State: ${state}`);
      }

      // Generate commitment: keccak256(walletAddress + proposalId + choice + secret)
      const commitment = ethers.solidityPackedKeccak256(
        ['address', 'uint256', 'uint8', 'string'],
        [address, proposalId.trim(), choice, secret]
      );

      setStatus({ type: 'info', message: 'Waiting for commit transaction confirmation...' });
      const tx = await governorContract.commitVote(proposalId.trim(), commitment);
      await tx.wait();

      setStatus({ type: 'success', message: '✅ Your vote has been committed. Hidden until reveal.' });
      setHasCommitted(true);
      setSecret(''); // Force re-entry for reveal
    } catch (error) {
      console.error('[commit] Error:', error);
      const errMsg = error.reason || error.message || '';
      if (errMsg.toLowerCase().includes('already committed')) {
        setStatus({ type: 'error', message: '⚠️ You have already committed a vote.' });
        try {
          await fetch('http://localhost:5000/rpc/log-vote-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: address, proposalId: proposalId.trim(), errorType: 'duplicate' })
          });
        } catch (e) {}
      } else {
        setStatus({ type: 'error', message: error.message || 'Error committing vote.' });
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRevealVote = async () => {
    if (!address) { alert('Please connect your wallet first.'); return; }
    
    // Requirement: If secret field is empty → block reveal and show warning
    if (!secret.trim()) {
      setStatus({ type: 'warning', message: 'Please enter your secret phrase to reveal your vote.' });
      return;
    }

    if (!proposalId.trim() || choice === null) {
      alert('Please select your choice.');
      return;
    }

    try {
      setIsProcessing(true);
      setStatus(null);

      const signer = await provider.getSigner();
      const configRes = await fetch('http://localhost:5000/config/contract');
      const configData = await configRes.json();
      
      const governorContract = new ethers.Contract(configData.governorAddress, GOVERNOR_ABI, signer);

      setStatus({ type: 'info', message: 'Waiting for reveal transaction confirmation...' });
      
      // Simulate transaction first to catch Invalid reveal
      try {
        await governorContract.revealVote.staticCall(proposalId.trim(), choice, secret);
      } catch (staticErr) {
         console.warn("Static call failed, reveal might fail");
      }
      
      const tx = await governorContract.revealVote(proposalId.trim(), choice, secret);
      const receipt = await tx.wait();

      // Check logs for RevealRejected
      const rejectedTopic = governorContract.interface.getEvent('RevealRejected').topicHash;
      const wasRejected = receipt.logs.some(log => log.topics[0] === rejectedTopic);

      if (wasRejected) {
        setStatus({ type: 'error', message: '⛔ Reveal failed — secret does not match commitment.' });
      } else {
        setStatus({ type: 'success', message: '✅ Your vote has been revealed and tallied.' });
        setHasRevealed(true);
      }
    } catch (error) {
      console.error('[reveal] Error:', error);
      setStatus({ type: 'error', message: error.reason || error.message || 'Error revealing vote.' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Cast On-Chain Vote</h1>
        <p className="page-subtitle">
          Secure your ballot with a Commit-Reveal scheme. Hide your vote until the reveal phase.
        </p>
      </div>

      <div className="glass-panel">
        <div className="form-group mb-4">
          <label className="form-label" htmlFor="proposalId">Proposal ID</label>
          <input
            id="proposalId"
            type="text"
            className="form-input"
            style={{ fontSize: '0.95rem', padding: '14px', fontFamily: 'monospace' }}
            placeholder="Paste full on-chain Proposal ID"
            value={proposalId}
            onChange={(e) => setProposalId(e.target.value)}
          />
        </div>

        {proposalState === 0 && (
          <div style={{ marginBottom: '16px', padding: '16px', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', color: '#fbbf24' }}>
            <p style={{ fontWeight: 600, marginBottom: '8px' }}>⏳ Proposal pending, advance blocks to activate.</p>
            <button 
              onClick={handleAdvanceToVoting} 
              disabled={isAdvancing}
              className="btn btn-primary" 
              style={{ padding: '8px 16px', fontSize: '0.9rem', width: 'auto' }}
            >
              {isAdvancing ? 'Advancing...' : '⏩ Advance to Voting'}
            </button>
          </div>
        )}
        
        {hasCommitted && !hasRevealed && (
          <div style={{ marginBottom: '16px', padding: '16px', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.3)', borderRadius: '8px', color: 'var(--accent-primary)' }}>
            <p style={{ fontWeight: 600, margin: 0 }}>🔒 Your vote has been committed. Hidden until reveal.</p>
          </div>
        )}

        {hasRevealed && (
          <div style={{ marginBottom: '16px', padding: '16px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', color: 'var(--success)' }}>
            <p style={{ fontWeight: 600, margin: 0 }}>✅ Your vote has been revealed and tallied.</p>
          </div>
        )}

        <div className="form-group mb-4">
          <label className="form-label">Secret Phrase</label>
          <input
            type="text"
            className="form-input"
            style={{ fontSize: '0.95rem', padding: '14px' }}
            placeholder="Enter a secret phrase for your vote"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            disabled={hasRevealed}
          />
        </div>

        <label className="form-label mb-4" style={{ display: 'block' }}>Select your choice:</label>
        <div className="content-grid mb-4" style={{ gap: '16px', gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {OPTIONS.map(opt => {
            const Icon = opt.icon;
            const isSelected = choice === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setChoice(opt.id)}
                className="btn"
                disabled={(proposalState !== 1 && proposalState !== null) || hasRevealed}
                style={{
                  display: 'flex', flexDirection: 'column', padding: '24px 16px', height: 'auto',
                  background: isSelected
                    ? `rgba(${opt.color === 'var(--success)' ? '16, 185, 129' : opt.color === 'var(--danger)' ? '239, 68, 68' : '148, 163, 184'}, 0.15)`
                    : 'rgba(255, 255, 255, 0.05)',
                  borderColor: isSelected ? opt.color : 'var(--panel-border)',
                  color:       isSelected ? opt.color : 'var(--text-main)',
                  transform:   isSelected ? 'translateY(-2px)' : 'none',
                  boxShadow:   isSelected ? `0 4px 12px rgba(${opt.color === 'var(--success)' ? '16, 185, 129' : opt.color === 'var(--danger)' ? '239, 68, 68' : '148, 163, 184'}, 0.2)` : 'none',
                  opacity:     (proposalState !== 1 && proposalState !== null) || hasRevealed ? 0.5 : 1,
                  cursor:      (proposalState !== 1 && proposalState !== null) || hasRevealed ? 'not-allowed' : 'pointer'
                }}
              >
                <Icon size={28} style={{ marginBottom: '12px', color: isSelected ? opt.color : 'var(--text-muted)' }} />
                <span style={{ fontWeight: 600, fontSize: '1.05rem' }}>{opt.label}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: '16px' }}>
          <button
            onClick={handleCommitVote}
            className="btn btn-primary"
            style={{ flex: 1, padding: '16px', fontSize: '1.05rem', opacity: (!address || !govBalance || govBalance === '0' || proposalState !== 1 || hasCommitted) ? 0.6 : 1 }}
            disabled={isProcessing || choice === null || !secret.trim() || !proposalId || !address || !govBalance || govBalance === '0' || proposalState !== 1 || hasCommitted}
          >
            <Lock size={18} style={{ marginRight: '8px' }} />
            {isProcessing && !hasCommitted ? 'Committing…' : hasCommitted ? 'Vote Committed' : 'Step 1: Commit Vote'}
          </button>

          <button
            onClick={handleRevealVote}
            className="btn"
            style={{ 
              flex: 1, padding: '16px', fontSize: '1.05rem', 
              background: 'var(--accent-primary)', color: 'white', border: 'none',
              opacity: (!hasCommitted || hasRevealed || isProcessing || proposalState !== 1) ? 0.6 : 1 
            }}
            disabled={!hasCommitted || hasRevealed || isProcessing || proposalState !== 1 || choice === null}
          >
            <Unlock size={18} style={{ marginRight: '8px' }} />
            {isProcessing && hasCommitted ? 'Revealing…' : hasRevealed ? 'Vote Revealed' : 'Step 2: Reveal Vote'}
          </button>
        </div>

        <div style={{
          marginTop: '16px', padding: '12px 16px',
          background: 'rgba(56,189,248,0.06)',
          border: '1px solid rgba(56,189,248,0.18)',
          borderRadius: '8px', fontSize: '0.82rem', color: 'var(--text-muted)',
          lineHeight: 1.6
        }}>
          <p style={{ fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '4px' }}>📋 How Commit-Reveal Works</p>
          <ol style={{ paddingLeft: '18px', margin: 0 }}>
            <li><strong>Commit:</strong> Submit a secure hash of your vote and secret. Your choice remains completely hidden on-chain.</li>
            <li><strong>Reveal:</strong> Provide the same choice and secret. The contract verifies your commitment and tallies your vote.</li>
          </ol>
        </div>

        {status && (
          <div
            className="glass-panel mt-4"
            style={{
              background:   status.type === 'success'   ? 'rgba(16, 185, 129, 0.05)'
                          : status.type === 'info'      ? 'rgba(56, 189, 248, 0.05)'
                          : status.type === 'warning'   ? 'rgba(251, 191, 36, 0.05)'
                          : status.type === 'duplicate' ? 'rgba(234, 179, 8, 0.05)'
                          : 'rgba(239, 68, 68, 0.05)',
              borderColor:  status.type === 'success'   ? 'rgba(16, 185, 129, 0.2)'
                          : status.type === 'info'      ? 'rgba(56, 189, 248, 0.2)'
                          : status.type === 'warning'   ? 'rgba(251, 191, 36, 0.3)'
                          : status.type === 'duplicate' ? 'rgba(234, 179, 8, 0.25)'
                          : 'rgba(239, 68, 68, 0.2)'
            }}
          >
            <h4 style={{
              color: status.type === 'success'   ? 'var(--success)'
                   : status.type === 'info'      ? 'var(--accent-primary)'
                   : status.type === 'warning'   ? '#fbbf24'
                   : status.type === 'duplicate' ? '#eab308'
                   : 'var(--danger)',
              marginBottom: '8px'
            }}>
              {status.type === 'success' ? '✅ Success' : status.type === 'info' ? 'ℹ️ Info' : status.type === 'warning' ? '⚠️ Warning' : status.type === 'duplicate' ? '⛔ Duplicate' : '❌ Error'}
            </h4>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{status.message}</div>
          </div>
        )}

      </div>
    </div>
  );
};

export default CastVote;
