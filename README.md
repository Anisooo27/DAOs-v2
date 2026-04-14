# DAO Governance System

> A full-stack, on-chain governance platform with commit-reveal voting, cryptographic nullifier enforcement, automated proposal lifecycle management, and ETH transfer proof telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-purple.svg)](https://soliditylang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.x-yellow.svg)](https://hardhat.org/)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Smart Contracts](#3-smart-contracts)
4. [Features](#4-features)
5. [Prerequisites](#5-prerequisites)
6. [Setup & Installation](#6-setup--installation)
7. [Governance Lifecycle Walkthrough](#7-governance-lifecycle-walkthrough)
8. [Vote Security (Commit-Reveal Scheme)](#8-vote-security-commit-reveal-scheme)
9. [API Reference](#9-api-reference)
10. [Running Tests](#10-running-tests)
11. [Troubleshooting](#11-troubleshooting)
12. [Future Upgrade Roadmap](#12-future-upgrade-roadmap)
13. [Repository Structure](#13-repository-structure)

---

## 1. Project Overview

This project implements a **production-ready DAO governance system** built on OpenZeppelin's Governor framework. It combines:

- **On-chain governance** — proposals, voting, timelock queue, treasury execution
- **Off-chain vote security** — a commit-reveal scheme with deterministic nullifiers that prevent double-voting at the cryptographic layer
- **Automated lifecycle management** — the backend relayer mines blocks, casts votes, and advances proposal state automatically
- **ETH Transfer Proof** — block-pinned balance snapshots verify treasury withdrawals before and after execution
- **Short Proposal IDs** — human-readable `P-001`, `P-002`… aliases alongside full 256-bit on-chain IDs

The system is designed to run locally against a Hardhat node for development, with a clear path to Sepolia/mainnet deployment.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          User (MetaMask)                                 │
│                    http://localhost:5173  (React / Vite)                 │
└────────────────────────────┬────────────────────────────────────────────┘
                             │  REST / JSON
┌────────────────────────────▼────────────────────────────────────────────┐
│                     Backend  (Node.js + Express)                         │
│                       http://localhost:5000                              │
│                                                                          │
│  POST /propose    →  save proposal, trigger autoAdvanceToSucceeded       │
│  POST /vote       →  commit-reveal verification + nullifier check        │
│  POST /submit/:id →  manually push tally on-chain                       │
│  POST /execute/:id→  queue → timelock delay → execute → ETH proof       │
│  GET  /proposals  →  live list with on-chain state, tally, shortId      │
│  GET  /config/contract → live contract addresses                         │
└──────────┬──────────────────────────────────────┬───────────────────────┘
           │  ethers.js v6                         │  Mongoose
┌──────────▼─────────────────┐       ┌─────────────▼──────────────────────┐
│   Hardhat Node              │       │  MongoDB (Atlas or local)           │
│   http://localhost:8545     │       │                                     │
│                             │       │  Collections:                       │
│   DAOGovernor               │       │    proposals  — shortId, calldata,  │
│   DAOTimelock  (1s delay)   │       │                 status, recipient   │
│   GOVToken     (ERC20Votes) │       │    votes      — commitment,         │
│   Treasury                  │       │                 nullifier, zkProof  │
└─────────────────────────────┘       │    delegations— signature proofs   │
                                      └────────────────────────────────────┘
```

### Data Flow

```
MetaMask signs proposal data
      ↓
POST /propose  →  MongoDB saves proposal  →  autoAdvanceToSucceeded()
      ↓
[background] mine votingDelay+1 blocks
             castVoteWithReason()
             mine votingPeriod+1 blocks
             state → Succeeded (4)
      ↓
User clicks "Queue & Execute"
      ↓
POST /execute  →  governor.queue()
               →  evm_increaseTime (3601s)
               →  governor.execute()
               →  ETH Transfer Proof logged
```

---

## 3. Smart Contracts

| Contract | File | Role |
|---|---|---|
| **GOVToken** | `contracts/GOVToken.sol` | ERC20Votes governance token — 1 million supply minted to deployer |
| **DAOGovernor** | `contracts/DAOGovernor.sol` | OpenZeppelin Governor — 0% quorum, 1-block delay, 50-block voting period |
| **DAOTimelock** | `contracts/DAOTimelock.sol` | TimelockController — 1 second delay (local) / 3600s (production) |
| **Treasury** | `contracts/Treasury.sol` | ETH vault — owned by Timelock, withdrawal callable only via governance |

### Key Governor Parameters

```solidity
GovernorSettings(
    1,    // votingDelay  — blocks to wait before voting opens
    50,   // votingPeriod — blocks the vote is open
    0     // proposalThreshold — minimum GOV to create a proposal
)
GovernorVotesQuorumFraction(0)  // 0% quorum — demo mode, 1 vote suffices
```

---

## 4. Features

### Governance

| Feature | Details |
|---|---|
| **Proposal creation** | Signed by proposer (MetaMask), stored in MongoDB with `shortId` alias |
| **Auto lifecycle** | Backend mines blocks and votes automatically after proposal creation |
| **Queue & Execute** | Timelock queue → EVM time advance → Governor execute |
| **Treasury withdrawal** | `withdrawETH(address, amount)` callable only via passed proposal |

### Vote Security

| Feature | Details |
|---|---|
| **Commit-reveal** | `commitment = keccak256(choice \| secret \| proposalId)` — hides vote choice |
| **Nullifier enforcement** | `nullifier = keccak256(voter \| proposalId)` — deterministic, secret-independent |
| **Double-vote prevention** | DB unique index + unconditional `findOne({voter, proposalId})` check |
| **Signature verification** | Server re-derives commitment and nullifier — never trusts client values |

### Operations

| Feature | Details |
|---|---|
| **ETH Transfer Proof** | Block-pinned `balanceBefore` / `balanceAfter` snapshots |
| **Nonce management** | `NonceManager` — 200ms settle delay + NONCE_EXPIRED retry |
| **Transaction mutex** | `withSignerLock` serializes all on-chain writes |
| **Event telemetry** | Polls `ProposalCreated` on-chain every 2s, logs to console |
| **Short IDs** | `P-001` format displayed in UI; full 256-bit ID used on-chain |

---

## 5. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 18+ | LTS recommended |
| npm | 9+ | Comes with Node |
| MetaMask | Latest | Browser extension for wallet connection |
| MongoDB | Atlas or local | Local: `mongod` on port 27017 |
| Git | Any | For cloning and pushes |

---

## 6. Setup & Installation

### Step 1 — Clone the repository

```bash
git clone https://github.com/Anisooo27/DAOs-v2.git
cd DAOs-v2/governor-starter/Design-and-Implement-a-DAO-Governance-Smart-Contract-System-with-Off-Chain-Voting-Integration
```

### Step 2 — Install root dependencies (Hardhat, contracts)

```bash
npm install
```

### Step 3 — Install backend dependencies

```bash
cd backend
npm install
cd ..
```

### Step 4 — Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

### Step 5 — Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```env
# MongoDB connection string
MONGODB_URI=mongodb://localhost:27017/dao_voting

# Hardhat local node RPC
RPC_URL=http://127.0.0.1:8545/

# Hardhat Account #0 private key (pre-funded in local node)
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Filled automatically by deploy.js:
# GOVERNOR_ADDRESS=
# TREASURY_ADDRESS=
```

### Step 6 — Start the local Hardhat node

```bash
# Terminal 1
npx hardhat node
```

Wait until you see:
```
Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/
```

### Step 7 — Deploy contracts

```bash
# Terminal 2
npx hardhat run scripts/deploy.js --network localhost
```

Expected output:
```
Deploying with: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
GOVToken:  0x5FbDB2315678afecb367f032d93F642f64180aa3
Timelock:  0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
Governor:  0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
Treasury:  0x0165878A594ca255338adfa4d48449f69242Eb8F
Treasury funded with 10 ETH. Current balance: 10000000000000000000
Deployed addresses saved to: .../backend/config/deployedAddresses.json
Updated backend/.env with latest contract addresses
```

> `deploy.js` automatically writes `backend/config/deployedAddresses.json` and updates `backend/.env`.
> No manual copy-paste of addresses needed.

### Step 8 — (Optional) Delegate voting power

```bash
npx hardhat run scripts/setupVoter.js --network localhost
```

> The backend auto-delegates on the first proposal if voting power is 0.
> You only need this for manual testing via the Hardhat console.

### Step 9 — Start the backend

```bash
# Terminal 3
cd backend
node server.js
```

Expected:
```
MongoDB connected successfully
[config] Serving Governor=0x9fE4..., Treasury=0x0165...
Backend server running on port 5000
[on-chain] Polling for ProposalCreated on 0x9fE4...
```

### Step 10 — Start the frontend

```bash
# Terminal 4
cd frontend
npm run dev
```

Open **http://localhost:5173** in your browser and connect MetaMask to `localhost:8545` (chain ID 31337).

---

## 7. Governance Lifecycle Walkthrough

### Full Demo: Propose → Vote → Execute → Proof

#### 1. Create a Proposal

- Navigate to **Create Proposal**
- Enter description (e.g. *"Withdraw 1 ETH to my wallet"*), recipient address, and amount
- Click **Submit** — MetaMask opens for signature
- Backend saves proposal, assigns `shortId = P-001`, and immediately triggers `autoAdvanceToSucceeded`

**Backend logs:**
```
[propose] Saved proposal P-001 (0x3f8c4a2b...). Triggering auto-tally.
[auto-tally] 0x3f8c4a2b... state: 0 (Pending)
[auto-tally] Signer votes: 1000000.0 GOV
[auto-tally] After delay mine: 1 (Active)
  [nonce] castVoteWithReason() nonce=3
[auto-tally] Vote cast. Tx: 0xabc...
[auto-tally] After period mine: 4 (Succeeded)
[auto-tally] ✅ 0x3f8c4a2b... SUCCEEDED.
```

#### 2. Cast a Secure Vote (optional — relayer already voted)

- Navigate to **Cast Vote**
- Select your choice (For / Against / Abstain)
- Click **Submit Vote** — the frontend generates:
  - `secret` — 32 random bytes via `window.crypto`
  - `commitment = keccak256(choice | secret | proposalId)`
  - `nullifier  = keccak256(voter | proposalId)`
  - MetaMask signs `commitment|proposalId`
- Backend verifies signature, commitment, and nullifier, then records the vote

#### 3. Queue & Execute

- Navigate to **Results**
- Find your proposal (now showing state `Succeeded`)
- Click **Queue & Execute**

**Backend logs:**
```
[execute] target=0x0165... value=1000000000000000000 calldata=0xe3c1be85...
  [nonce] Starting execute sequence at nonce=4
  [nonce] queue() nonce=4
[execute] Queued: 0xdef...
[execute] Advancing EVM time (3601s)...
  [nonce] execute() nonce=5
[execute] ✅ Executed! Tx: 0xghi... | Block: 72

[execute] ╔══ ETH Transfer Proof ═════════════════
[execute] ║  Recipient:  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
[execute] ║  Block:      Before=71 → After=72
[execute] ║  Balance:    10000.0 → 10001.0 ETH
[execute] ║  Net Change: +1.0 ETH  ✅
[execute] ╚══════════════════════════════════════
```

### State Machine

```
0 Pending   ──(mine votingDelay+1)──────────────► 1 Active
1 Active    ──(castVote + mine votingPeriod+1)──► 4 Succeeded  ✅
                                                 ► 3 Defeated   ❌ (no votes or quorum unmet)
4 Succeeded ──(governor.queue())────────────────► 5 Queued
5 Queued    ──(timelockDelay + governor.execute)► 7 Executed   🏁
```

---

## 8. Vote Security (Commit-Reveal Scheme)

### How it works

```
Client (browser)
  secret     = window.crypto.getRandomValues(new Uint8Array(32))
  commitment = keccak256(choice + "|" + secret + "|" + proposalId)
  nullifier  = keccak256(voter.toLowerCase() + "|" + proposalId)
  signature  = MetaMask.sign(commitment + "|" + proposalId)

POST /vote  →  { proposalId, voter, choice, commitment, nullifier, secret, signature }

Server (backend)
  1. ethers.verifyMessage(commitment|proposalId, signature) === voter   ← signature valid?
  2. keccak256(choice|secret|proposalId) === commitment                 ← commitment valid?
  3. keccak256(voter|proposalId) === canonicalNullifier                 ← nullifier correct?
  4. Vote.findOne({ voter, proposalId }) === null                       ← not already voted?
  5. Save vote with server-derived canonicalNullifier
```

### Why nullifier excludes secret

The nullifier is **intentionally secret-independent**:

```
nullifier = keccak256(voter | proposalId)   ← fixed per account per proposal
```

If the secret were included, a voter could regenerate a different nullifier by changing
their secret and submit a second vote. The current design makes double-voting impossible
regardless of how many secrets a client generates.

### Double-Vote Protection Layers

| Layer | Mechanism |
|---|---|
| **Server derivation** | Nullifier always re-derived server-side — client value is only verified, never trusted |
| **Unconditional DB check** | `Vote.findOne({ voter, proposalId })` runs before save, even if no nullifier was sent |
| **MongoDB unique index** | `{ nullifier: 1 }` unique index catches any race conditions that bypass the pre-check |
| **409 response** | Returns `"Already voted"` with a distinct amber UI state — not a generic error |

---

## 9. API Reference

### Proposals

| Method | Endpoint | Body / Params | Response |
|---|---|---|---|
| `POST` | `/propose` | `{ proposalId, proposerAddress, description, target, value, calldata, recipient, amount, signature }` | `{ proposalId, shortId, autoTally: true }` |
| `GET` | `/proposals` | — | Array of proposals with `results`, `securedVotes`, `status`, `shortId` |
| `PATCH` | `/proposals/:id/status` | `{ status }` | `{ success, proposal }` |

### Voting

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `POST` | `/vote` | `{ proposalId, voter, choice, commitment, nullifier, secret, signature }` | `{ message, secured, nullifier, zkProofVersion }` |

### Lifecycle

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/submit/:proposalId` | Push tally on-chain (states 0→4). State 4 short-circuits as already-succeeded. |
| `POST` | `/execute/:proposalId` | Queue → timelock advance → execute → ETH proof |
| `POST` | `/delegate` | Record off-chain delegation with signature |

### Utility

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check — `{ status: "ok", timestamp }` |
| `GET` | `/config/contract` | Live governor + treasury addresses from `deployedAddresses.json` |
| `DELETE` | `/api/admin/reset` | Wipe all proposals (disabled in production) |

---

## 10. Running Tests

### Compile contracts

```bash
npx hardhat compile
```

### Run the full test suite

```bash
npx hardhat test
```

### Run with gas report

```bash
REPORT_GAS=true npx hardhat test
```

### Expected output

```
  DAO Governance Lifecycle
    Setup
      ✓ deployer holds all GOV tokens
      ✓ deployer has voting power after delegation
      ✓ treasury is funded with 10 ETH
      ✓ governor quorum is 0 (demo mode)
    Proposal Creation
      ✓ creates a proposal and emits ProposalCreated event
      ✓ moves Pending → Active after mining votingDelay+1 blocks
    Voting
      ✓ counts a For vote correctly
      ✓ proposal with for votes succeeds after voting period
    Full Lifecycle
      ✓ executes withdrawal and delivers ETH to recipient (66ms)
      ✓ runs two sequential proposals without nonce errors (115ms)
    Vote Double-Spend Prevention
      ✓ prevents the same address from voting twice on-chain
    Treasury Access Control
      ✓ rejects direct withdrawals from non-owner
      ✓ accepts ETH deposits via receive()

  13 passing (2s)
```

### Test coverage

| Suite | Tests | What is verified |
|---|---|---|
| Setup | 4 | Token supply, voting power, treasury balance, quorum=0 |
| Proposal Creation | 2 | Proposal saved, state Pending→Active |
| Voting | 2 | Vote counted, state Active→Succeeded |
| Full Lifecycle | 2 | ETH transferred, two sequential proposals (nonce stability) |
| Vote Double-Spend | 1 | Second `castVote()` reverts on-chain |
| Treasury Access | 2 | Non-owner rejected, `receive()` deposits work |

---

## 11. Troubleshooting

### Proposals go to Defeated (state 3) instead of Succeeded

**Cause:** Relayer has 0 voting power because the delegation checkpoint was never created on this Hardhat node session.

**Fix (automatic):** `autoAdvanceToSucceeded` calls `getVotes(signer)` before voting. If the result is `0`, it auto-delegates and re-initializes the nonce before proceeding.

**Manual fix:**
```bash
npx hardhat run scripts/setupVoter.js --network localhost
```

---

### "Governor: unknown proposal id"

Two distinct root causes:

#### A — Stale contract addresses

Hardhat was restarted. The browser/backend still refers to the old Governor.

```bash
# Redeploy (auto-updates .env and deployedAddresses.json)
npx hardhat run scripts/deploy.js --network localhost

# Restart backend
node server.js
```

#### B — Calldata `0x` prefix mismatch

`proposalId = keccak256(targets, values, calldatas, descHash)`. If calldata in MongoDB
is missing its `0x` prefix, the hash won't match what the Governor has on-chain.

**Fix (applied):** The backend normalizes calldata to always be `0x`-prefixed both at
save time (`/propose`) and at queue/execute time.

---

### "Nonce too low" / NONCE_EXPIRED

**Cause:** Hardhat's automining is asynchronous. Reading `getTransactionCount('pending')`
immediately after a prior transaction can return a stale count before the block is mined.

**Fix (applied — three layers):**

| Layer | Mechanism |
|---|---|
| **Settle delay** | `NonceManager.init()` waits 200ms before reading nonce |
| **NONCE_EXPIRED retry** | `sendTx()` catches the error, waits 300ms, re-fetches nonce, retries once |
| **Mutex** | `withSignerLock` ensures auto-tally, submit, and execute never run concurrently |

**Expected log pattern (correct):**
```
[nonce] castVoteWithReason() nonce=3
[nonce] queue()              nonce=4
[nonce] execute()            nonce=5
```

---

### "Cannot push tally: proposal is Succeeded (4)"

**Cause:** `autoAdvanceToSucceeded` ran in the background immediately after proposal creation.
If the user then clicks "Push Tally", `/submit` sees state=4.

**Fix (applied):** `/submit` treats state=4 as an immediate success:
```json
{ "success": true, "state": 4, "alreadySucceeded": true }
```
The UI can proceed directly to Queue & Execute.

---

### "JsonRpcProvider failed to detect network"

**Cause:** The backend started before the Hardhat node was ready.

**Fix:** Start the Hardhat node first. Wait for:
```
Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/
```
Then start the backend.

---

### MetaMask shows wrong network

Ensure MetaMask is connected to the Hardhat local network:

| Field | Value |
|---|---|
| Network Name | Hardhat Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency | ETH |

---

## 12. Future Upgrade Roadmap

### Phase 1 — Full ZK-SNARK Voting (v1)

Replace the current commit-reveal "simulated ZKP" with real Groth16 proofs using [snarkjs](https://github.com/iden3/snarkjs) + [Circom](https://github.com/iden3/circom).

```
Current (v0):  commitment = keccak256(choice|secret|proposalId)   [off-chain only]
Future  (v1):  commitment = Poseidon(choice, secret, proposalId)  [ZK circuit]
               nullifier  = Poseidon(voterPrivKey, proposalId)    [ZK circuit]
               proof      = Groth16(witness)                      [verifiable on-chain]
```

**Benefits:** Choice is provably hidden even from the backend. Double-vote is enforced
on-chain by the verifier contract, not just by the database.

**Steps:**
1. Write a Circom circuit for commitment + nullifier + range check on choice
2. Run trusted setup ceremony (`snarkjs groth16 setup`)
3. Bundle `.wasm` + `.zkey` in the frontend
4. Deploy a `Verifier.sol` contract
5. Backend calls `verifier.verifyProof()` before recording the vote

---

### Phase 2 — Testnet / Mainnet Deployment

| Item | Change required |
|---|---|
| `timelockDelay` | Change from `1s` to `3600s` (1 hour) or `86400s` (1 day) |
| `votingDelay` | Change from `1 block` to `7200 blocks` (~1 day on mainnet) |
| `votingPeriod` | Change from `50 blocks` to `50400 blocks` (~1 week) |
| `quorum` | Change from `0%` to `4%` (OpenZeppelin default) |
| `/execute` endpoint | Remove `hardhat_mine` / `evm_increaseTime` calls — use real-time polling |
| `PRIVATE_KEY` | Use a hardware wallet or KMS key, never store in `.env` in production |
| MongoDB | Migrate from local to MongoDB Atlas with IP allowlist |

---

### Phase 3 — Token Distribution & Delegation UI

- Airdrop GOV tokens to community members
- Build a delegation leaderboard
- Allow meta-transactions for gasless delegation (EIP-712 + `delegateBySig`)

---

### Phase 4 — Governance Analytics Dashboard

- Real-time charts for for/against/abstain tallies per proposal
- Voter participation rate over time
- Treasury balance history
- On-chain event indexing (The Graph subgraph or custom poller)

---

### Phase 5 — Multi-Sig Emergency Veto

- Add a `GuardianMultiSig` that can cancel any queued proposal within the timelock delay
- Prevents governance attacks while the DAO is still bootstrapping

---

## 13. Repository Structure

```
.
├── contracts/
│   ├── DAOGovernor.sol          # Governor (0% quorum, 1-block delay, 50-block period)
│   ├── DAOTimelock.sol          # TimelockController (1s delay for local dev)
│   ├── GOVToken.sol             # ERC20Votes token (1M supply minted to deployer)
│   └── Treasury.sol             # ETH vault — onlyOwner = Timelock
│
├── scripts/
│   ├── deploy.js                # Deploy all 4 contracts, fund Treasury, write config
│   └── setupVoter.js            # Delegate voting power to deployer address
│
├── test/
│   └── daoLifecycle.test.js     # 13 Hardhat/Chai integration tests
│
├── backend/
│   ├── server.js                # Express API, NonceManager, lifecycle automation
│   ├── models/
│   │   ├── Proposal.js          # { proposalId, shortId, calldata, status, recipient }
│   │   ├── Vote.js              # { commitment, nullifier, secret, zkProofVersion }
│   │   └── Delegation.js        # { delegatorAddress, delegateeAddress, signature }
│   └── config/
│       ├── contractConfig.js    # Loads ABI + addresses from env
│       └── deployedAddresses.json # Written by deploy.js — source of truth
│
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── CreateProposal.jsx   # Propose + MetaMask sign
│   │   │   ├── CastVote.jsx         # Commit-reveal vote generation
│   │   │   ├── Results.jsx          # Proposal list + Queue & Execute
│   │   │   └── AllProposals.jsx     # Browse all proposals by shortId
│   │   └── config.js               # API_BASE_URL
│   └── package.json
│
├── hardhat.config.js            # Solidity 0.8.20, optimizer on, localhost network
├── package.json                 # Root —Hardhat + OpenZeppelin dependencies
├── docker-compose.yml           # Optional — run backend + MongoDB in containers
├── .env.example                 # Template for backend/.env
└── README.md                    # This file
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*Built as a learning project demonstrating production governance patterns. Not audited — do not use on mainnet without a security review.*