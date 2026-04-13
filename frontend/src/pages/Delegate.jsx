import { useState } from 'react';
import { UserPlus, Info } from 'lucide-react';

const Delegate = ({ provider, address }) => {
  const [delegatee, setDelegatee] = useState('');
  const [isDelegating, setIsDelegating] = useState(false);
  const [txHash, setTxHash] = useState('');

  const handleDelegate = async (e) => {
    e.preventDefault();
    if (!address) {
      alert("Please connect your wallet first");
      return;
    }

    try {
      setIsDelegating(true);
      if (!provider) throw new Error("Wallet provider not found");
      const signer = await provider.getSigner();
      
      const message = `Delegate votes to ${delegatee}`;
      const signature = await signer.signMessage(message);

      const response = await fetch('http://localhost:5000/delegate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          delegatorAddress: address,
          delegateeAddress: delegatee,
          signature
        })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save delegation to backend');
      }

      setTxHash(signature); // Display the signature as proof
      setDelegatee('');
    } catch (error) {
      console.error("Error delegating votes:", error);
      alert(error.message || "Failed to delegate votes");
    } finally {
      setIsDelegating(false);
    }
  };

  return (
    <div className="form-container">
      <div className="page-header">
        <h1 className="page-title">Delegate Votes</h1>
        <p className="page-subtitle">Assign your governance voting power to yourself or a trusted representative.</p>
      </div>

      <div className="glass-panel">
        <form onSubmit={handleDelegate}>
          <div className="form-group">
            <label className="form-label" htmlFor="delegatee">Delegatee Address</label>
            <input
              id="delegatee"
              type="text"
              className="form-input"
              placeholder="0x..."
              value={delegatee}
              onChange={(e) => setDelegatee(e.target.value)}
              required
            />
            <p className="mt-4 text-muted" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Info size={14} /> To vote yourself, delegate to your own address.
            </p>
          </div>

          <button 
            type="submit" 
            className="btn btn-primary" 
            style={{ width: '100%', padding: '14px' }}
            disabled={isDelegating || !address}
          >
            <UserPlus size={18} />
            {isDelegating ? 'Delegating...' : 'Delegate Votes'}
          </button>
        </form>

        {txHash && (
          <div className="glass-panel mt-4" style={{ background: 'rgba(16, 185, 129, 0.05)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
            <h4 style={{ color: 'var(--success)', marginBottom: '8px' }}>Delegation Successful!</h4>
            <div style={{ wordBreak: 'break-all', fontSize: '0.85rem' }}>
              <span className="text-muted">Transaction Hash: </span>
              {txHash}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Delegate;
