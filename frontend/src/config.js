/**
 * Centralized API configuration for the frontend.
 * VITE_BACKEND_URL should be set in the Vercel dashboard.
 * Local default points to the local node server.
 */
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

export default {
  BACKEND_URL,
  VOTE_ENDPOINT: `${BACKEND_URL}/vote`,
  RESULTS_ENDPOINT: (proposalId) => `${BACKEND_URL}/results/${proposalId}`,
  PROPOSALS_ENDPOINT: `${BACKEND_URL}/proposals`,
  SUBMIT_ENDPOINT: (proposalId) => `${BACKEND_URL}/submit/${proposalId}`,
  EXECUTE_ENDPOINT: (proposalId) => `${BACKEND_URL}/execute/${proposalId}`,
  CONFIG_ENDPOINT: `${BACKEND_URL}/config/contract`,
};
