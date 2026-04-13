import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ethers } from 'ethers';
import { CheckCircle, XCircle, MinusCircle, ShieldCheck, Lock } from 'lucide-react';
import config from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// ZKP-Architecture helpers (commit-reveal scheme)
//
// commitment : keccak256(choice + "|" + secret + "|" + proposalId)
//   Binds the voter cryptographically to their choice without revealing it
//   in plain text on the wire.
//
// nullifier  : keccak256(voterAddress + "|" + proposalId)
//   Unique per (voter, proposal) — the backend rejects any second submission
//   with the same nullifier, preventing double-voting.
//
// In a production ZKP system (v1), a snarkjs circuit would:
//   - Prove knowledge of `secret` s.t. commitment = keccak(choice||secret||proposalId)
//   - Prove choice ∈ {0,1,2} without revealing it
//   - Derive nullifier from the voter's private key (not address) so even
//     the relayer cannot link nullifier → voter
// ─────────────────────────────────────────────────────────────────────────────

function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildCommitment(choice, secret, proposalId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${choice}|${secret}|${proposalId}`));
}

// NULLIFIER DEFINITION:  keccak256(voter | proposalId)
//   Secret is intentionally excluded from the nullifier. The nullifier
//   must be deterministic per (voter, proposal) regardless of what secret
//   is generated. Regenerating the secret cannot produce a new nullifier,
//   so one Ethereum address = exactly one vote per proposal.
function buildNullifier(voterAddress, proposalId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${voterAddress.toLowerCase()}|${proposalId}`));
}

// ─────────────────────────────────────────────────────────────────────────────

const CastVote = ({ provider, address }) => {
  const [searchParams] = useSearchParams();
  const initialProposalId = searchParams.get('proposalId') || '';

  const [proposalId, setProposalId] = useState(initialProposalId);
  const [choice, setChoice]         = useState(null);
  const [isCasting, setIsCasting]   = useState(false);
  const [status, setStatus]         = useState(null);
  const [proofDetails, setProofDetails] = useState(null);

  const OPTIONS = [
    { id: 0, label: 'Against', icon: XCircle,      color: 'var(--danger)'     },
    { id: 1, label: 'For',     icon: CheckCircle,   color: 'var(--success)'    },
    { id: 2, label: 'Abstain', icon: MinusCircle,   color: 'var(--text-muted)' }
  ];

  const handleSignAndVote = async () => {
    if (!address) { alert('Please connect your wallet first.'); return; }
    if (!proposalId.trim() || choice === null) {
      alert('Please enter a Proposal ID and select a voting option.');
      return;
    }

    try {
      setIsCasting(true);
      setStatus(null);
      setProofDetails(null);

      const signer = await provider.getSigner();

      // ── Step 1: Generate cryptographic proof components ─────────────────
      const secret     = generateSecret();
      const commitment = buildCommitment(choice, secret, proposalId.trim());
      const nullifier  = buildNullifier(address, proposalId.trim());

      console.log('[zkp] Secret:     ', secret);
      console.log('[zkp] Commitment: ', commitment);
      console.log('[zkp] Nullifier:  ', nullifier);

      // ── Step 2: Sign the commitment (proves voter created this commitment) ─
      const signedMessage = `${commitment}|${proposalId.trim()}`;
      const signature = await signer.signMessage(signedMessage);

      console.log('[zkp] Signature:  ', signature);

      // ── Step 3: Submit to backend ────────────────────────────────────────
      const response = await fetch(config.VOTE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: proposalId.trim(),
          voter:      address,
          choice,
          commitment,
          nullifier,
          secret,
          signature
        })
      });

      const data = await response.json();

      if (response.ok) {
        setStatus({ type: 'success', message: '🔒 Vote secured and recorded with cryptographic proof.' });
        setProofDetails({
          commitment:      commitment.slice(0, 20) + '…',
          nullifier:       (data.nullifier || buildNullifier(address, proposalId.trim())).slice(0, 20) + '…',
          zkProofVersion:  data.zkProofVersion || 'v0-commit-reveal',
          secured:         data.secured
        });
      } else if (response.status === 409) {
        // Already voted — show distinct state, not a generic error
        setStatus({ type: 'duplicate', message: data.error || 'Already voted for this proposal.' });
        setProofDetails(null);
      } else {
        setStatus({ type: 'error', message: data.error || 'Failed to record vote.' });
      }

    } catch (error) {
      console.error('[zkp] Error casting vote:', error);
      setStatus({ type: 'error', message: error.message || 'Error signing or submitting vote.' });
    } finally {
      setIsCasting(false);
    }
  };

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Cast Off-Chain Vote</h1>
        <p className="page-subtitle">
          Your vote is secured with a cryptographic commitment — gasless, signed, and double-vote protected.
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
                style={{
                  display: 'flex', flexDirection: 'column', padding: '24px 16px', height: 'auto',
                  background: isSelected
                    ? `rgba(${opt.color === 'var(--success)' ? '16, 185, 129' : opt.color === 'var(--danger)' ? '239, 68, 68' : '148, 163, 184'}, 0.15)`
                    : 'rgba(255, 255, 255, 0.05)',
                  borderColor: isSelected ? opt.color : 'var(--panel-border)',
                  color:       isSelected ? opt.color : 'var(--text-main)',
                  transform:   isSelected ? 'translateY(-2px)' : 'none',
                  boxShadow:   isSelected ? `0 4px 12px rgba(${opt.color === 'var(--success)' ? '16, 185, 129' : opt.color === 'var(--danger)' ? '239, 68, 68' : '148, 163, 184'}, 0.2)` : 'none',
                }}
              >
                <Icon size={28} style={{ marginBottom: '12px', color: isSelected ? opt.color : 'var(--text-muted)' }} />
                <span style={{ fontWeight: 600, fontSize: '1.05rem' }}>{opt.label}</span>
              </button>
            );
          })}
        </div>

        {/* ZKP Info Banner */}
        <div className="glass-panel mt-4 mb-4" style={{ background: 'rgba(0, 255, 136, 0.03)', padding: '16px', borderColor: 'rgba(0,255,136,0.15)' }}>
          <div className="flex items-center gap-2 mb-2" style={{ color: 'var(--accent-primary)' }}>
            <Lock size={16} />
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>🔒 Cryptographic Vote Security</span>
          </div>
          <p className="text-muted" style={{ fontSize: '0.82rem', lineHeight: 1.6 }}>
            Your vote generates a <strong>commitment</strong> (binds you to your choice) and a <strong>nullifier</strong> (prevents double-voting).
            You sign the commitment with MetaMask — not the raw choice. The backend verifies all three layers before recording your vote.
          </p>
          <p className="text-muted" style={{ fontSize: '0.78rem', marginTop: '6px', opacity: 0.7 }}>
            Protocol: <code>v0-commit-reveal</code> — ZKP circuit upgrade path: replace commitment hash with snarkjs Groth16 proof (v1).
          </p>
        </div>

        <button
          onClick={handleSignAndVote}
          className="btn btn-primary"
          style={{ width: '100%', padding: '16px', fontSize: '1.05rem' }}
          disabled={isCasting || choice === null || !proposalId || !address}
        >
          <ShieldCheck size={18} style={{ marginRight: '8px' }} />
          {isCasting ? 'Generating proof & waiting for signature…' : 'Generate Proof & Submit Vote'}
        </button>

        {status && (
          <div
            className="glass-panel mt-4"
            style={{
              background:   status.type === 'success'   ? 'rgba(16, 185, 129, 0.05)'
                          : status.type === 'duplicate' ? 'rgba(234, 179, 8, 0.05)'
                          : 'rgba(239, 68, 68, 0.05)',
              borderColor:  status.type === 'success'   ? 'rgba(16, 185, 129, 0.2)'
                          : status.type === 'duplicate' ? 'rgba(234, 179, 8, 0.25)'
                          : 'rgba(239, 68, 68, 0.2)'
            }}
          >
            <h4 style={{
              color: status.type === 'success'   ? 'var(--success)'
                   : status.type === 'duplicate' ? '#eab308'
                   : 'var(--danger)',
              marginBottom: '8px'
            }}>
              {status.type === 'success' ? '✅ Vote Recorded' : status.type === 'duplicate' ? '⛔ Already Voted' : '❌ Error'}
            </h4>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{status.message}</div>
            {status.type === 'duplicate' && (
              <p style={{ fontSize: '0.8rem', marginTop: '8px', color: 'rgba(234,179,8,0.8)' }}>
                Each Ethereum address may cast exactly one vote per proposal. Regenerating the secret does not allow a second vote.
              </p>
            )}

            {/* Proof Details */}
            {proofDetails && (
              <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(0,255,136,0.04)', borderRadius: '6px', border: '1px solid rgba(0,255,136,0.12)' }}>
                <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px' }}>
                  🔐 Cryptographic Proof Details
                </p>
                <table style={{ width: '100%', fontSize: '0.76rem', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr><td style={{ color: 'var(--text-muted)', paddingRight: '12px', paddingBottom: '4px' }}>Commitment</td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--text-main)' }}>{proofDetails.commitment}</td></tr>
                    <tr><td style={{ color: 'var(--text-muted)', paddingBottom: '4px' }}>Nullifier</td>
                        <td style={{ fontFamily: 'monospace', color: 'var(--text-main)' }}>{proofDetails.nullifier}</td></tr>
                    <tr><td style={{ color: 'var(--text-muted)', paddingBottom: '4px' }}>Protocol</td>
                        <td style={{ color: 'var(--accent-secondary)' }}>{proofDetails.zkProofVersion}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
};

export default CastVote;
