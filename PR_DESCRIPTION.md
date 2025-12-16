feat(blockchain): Implement On-Chain Contribution Certificates (SBTs)

## Description
This PR implements the infrastructure for issuing **On-Chain Contribution Certificates** as Soulbound Tokens (SBTs) on the XDC network. This addresses Issue #9 and allows the platform to recognize contributors with verifiable, non-transferable on-chain credentials.

## Key Changes

### Smart Contracts
- **New Contract (`ContributionCertificate.sol`)**:
    - Implements an **ERC721** standard token.
    - **Soulbound**: Uses OpenZeppelin `_update` hook to prevent *all* transfers (including approvals), ensuring tokens are non-transferable.
    - **Owner Mintable**: Only the contract owner (Platform Admin) can mint certificates.
    - Stores metadata via `tokenURI`.

### Backend
- **Blockchain Service (`server/blockchain.ts`)**:
    - Initializes the `ContributionCertificate` contract with robust error handling.
    - Implements `issueCertificate(userAddress, metadataUri)` with transaction receipt validation and gas price logic.
- **API Routes (`server/routes/certificateRoutes.ts`)**:
    - **Secure Endpoint**: `POST /api/certificates/issue` for minting certificates.
    - **Security**: Protected with `requireAuth` and `csrfProtection`. Restricted to Admin users.
    - **Validation**: Strict validation for `userAddress` format and parameter presence.
- **Configuration**:
    - Added `contributionCertificateAddress` to `server/config.ts` (Env: `CONTRIBUTION_CERTIFICATE_ADDRESS`).

### DevTools
- **Deployment**: `scripts/deploy_certificate.cjs` updated with proper gas price handling for XDC Mainnet/Testnet.
- **Testing**: `test/ContributionCertificate.test.cjs` verifies:
    - Minting functionality.
    - Soulbound property (blocking transfers).
    - Access control (non-owner minting prevention).

## How to Test
1. **Contract Verification**:
   Run the tests:
   ```bash
   npx hardhat test test/ContributionCertificate.test.cjs
   ```
2. **Deployment**:
   Deploy to testnet:
   ```bash
   npx hardhat run scripts/deploy_certificate.cjs --network xdcTestnet
   ```

## Checklist
- [x] Smart Contract developed and robustly soulbound.
- [x] Backend integration secure and complete.
- [x] API endpoint implemented with Auth/Validation.
- [x] Comprehensive Unit tests passed.
