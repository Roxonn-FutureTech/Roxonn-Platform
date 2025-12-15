import { ethers } from 'ethers';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { log } from './utils';
import { config } from './config';
import { storage } from './storage';
import { transactionService } from './transactionService';
import type { 
    Repository, 
    IssueReward, 
    AllocateRewardResponse,
    UnifiedPoolInfo,
    IssueBountyDetails
} from '../shared/schema'; 
import { getWalletPrivateKey } from "./tatum";
import { walletService } from "./walletService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read contract artifacts
const CustomForwarderContract = JSON.parse(
  readFileSync(join(__dirname, '../contracts/artifacts/contracts/CustomForwarder.sol/CustomForwarder.json'), 'utf-8')
);
const ROXNTokenContract = JSON.parse(
  readFileSync(join(__dirname, '../contracts/artifacts/contracts/ROXNToken.sol/ROXNToken.json'), 'utf-8')
);
const DualCurrencyRepoRewardsContractArtifact = JSON.parse(
  readFileSync(join(__dirname, '../contracts/artifacts/contracts/DualCurrencyRepoRewards.sol/DualCurrencyRepoRewards.json'), 'utf-8')
);
const ProofOfComputeContractArtifact = JSON.parse(
  readFileSync(join(__dirname, '../contracts/artifacts/contracts/ProofOfCompute.sol/ProofOfCompute.json'), 'utf-8')
);

const CustomForwarderABI = CustomForwarderContract.abi;
const ROXNTokenABI = ROXNTokenContract.abi;
const UnifiedRewardsABI = DualCurrencyRepoRewardsContractArtifact.abi;
const ProofOfComputeABI = ProofOfComputeContractArtifact.abi;

interface TransactionRequest {
    to: string;
    data: string;
    gasPrice: bigint;
    gasLimit: bigint;
    chainId: number;
    nonce?: number;
}

interface ExtendedContract extends ethers.Contract {
    [key: string]: any;
    addPoolManager(repoId: number, poolManager: string, username: string, githubId: number): Promise<ethers.ContractTransaction>;
    allocateIssueReward(repoId: number, issueId: number, reward: bigint, _currencyType: number): Promise<ethers.ContractTransaction>;
    addXDCFundToRepository(repoId: number, overrides?: ethers.Overrides & { from?: string | Promise<string> }): Promise<ethers.TransactionResponse>;
    addROXNFundToRepository(repoId: number, amount: bigint, overrides?: ethers.Overrides): Promise<ethers.TransactionResponse>;
    addUSDCFundToRepository(repoId: number, amount: bigint, overrides?: ethers.Overrides): Promise<ethers.TransactionResponse>;
    distributeReward(repoId: number, issueId: number, contributorAddress: string): Promise<ethers.ContractTransaction>;
    getRepository(repoId: number): Promise<[string[], string[], bigint, bigint, bigint, any[]]>;
    getIssueRewards(repoId: number, issueIds: number[]): Promise<any[]>;
    registerUser(userAddress: string, username: string, typeOfUser: string, overrides?: ethers.Overrides): Promise<ethers.TransactionResponse>;
}

interface ProofOfComputeContract extends ethers.Contract {
    [key: string]: any;
    computeUnits(provider: string): Promise<bigint>;
    nodes(nodeId: string): Promise<{ isRegistered: boolean; owner: string; }>;
    registerNode(nodeId: string, overrides?: ethers.Overrides): Promise<ethers.TransactionResponse>;
    recordCompute(provider: string, overrides?: ethers.Overrides): Promise<ethers.TransactionResponse>;
}

interface TokenContract extends ethers.Contract {
    [key: string]: any;
    balanceOf(account: string): Promise<bigint>;
    approve(spender: string, amount: bigint): Promise<ethers.ContractTransaction>;
    transfer(to: string, amount: bigint): Promise<ethers.ContractTransaction>;
    transferFrom(from: string, to: string, amount: bigint): Promise<ethers.ContractTransaction>;
    allowance(owner: string, spender: string): Promise<bigint>;
}

type DualCurrencyRepositoryDetailsTuple = [
    string[],   // poolManagers
    string[],   // contributors
    bigint,     // poolRewardsXDC
    bigint,     // poolRewardsROXN
    bigint,     // poolRewardsUSDC
    any[]       // issues
];

interface UnsignedTransaction {
    to: string;
    data: string;
    gasPrice: bigint;
    gasLimit: bigint;
    chainId: number;
    nonce: number;
}

export class BlockchainService {
    private provider!: ethers.JsonRpcProvider;
    private relayerWallet!: ethers.Wallet;
    private contract!: ExtendedContract;
    private forwarderContract!: ethers.Contract;
    private tokenContract!: TokenContract;
    private usdcTokenContract!: TokenContract; // USDC ERC20 token (USDC rewards handled by main contract)
    private proofOfComputeContract!: ProofOfComputeContract;
    private userWallets: Map<string, ethers.Wallet> = new Map();

    constructor() {
        this.initializeProvider().catch(error => {
            log(`Critical error during blockchain service initialization: ${error}`, "blockchain-ERROR");
        });
    }

    private mapStatus(status: number | bigint): string {
        const numericStatus = Number(status);
        switch (numericStatus) {
            case 0: return "Created";
            case 1: return "Allocated";
            case 2: return "Distributed";
            case 3: return "Cancelled";
            default: return "Unknown";
        }
    }
    
    private async initializeContractParameters() {
        try {
            log('Initializing contract parameters', 'blockchain');
            const currentFeeCollector = await this.contract.feeCollector();
            const currentFeeRate = await this.contract.platformFeeRate();
            const configuredFeeCollector = ethers.getAddress(config.feeCollectorAddress.replace('xdc', '0x'));
            
            if (currentFeeCollector.toLowerCase() !== configuredFeeCollector.toLowerCase() || 
                currentFeeRate.toString() !== config.platformFeeRate.toString()) {
                
                log(`Updating fee parameters: 
  Collector: ${configuredFeeCollector}
  Rate: ${config.platformFeeRate}`, 'blockchain');
                
                log(`Calling updateFeeParameters with collector: ${configuredFeeCollector}, platformRate: ${config.platformFeeRate}, contributorRate: ${config.contributorFeeRate}`, 'blockchain-debug');
                const tx = await this.contract.updateFeeParameters(
                    configuredFeeCollector,
                    config.platformFeeRate,
                    config.contributorFeeRate
                );
                
                const receipt = await tx.wait();
                
                if (!receipt) {
                    throw new Error('Failed to update fee parameters');
                }
                
                log('Fee parameters successfully updated', 'blockchain');
            } else {
                log('Fee parameters already up to date', 'blockchain');
            }
        } catch (error) {
            log(`Error initializing contract parameters: ${error}`, 'blockchain');
        }
    }

    private async initializeProvider() {
        try {
            log(`Initializing provider with node URL: ${config.xdcNodeUrl}`, "blockchain");

            const rpcEndpoints = [
                config.xdcNodeUrl,
                'https://rpc.xinfin.network'
            ];

            let connectedProvider: ethers.JsonRpcProvider | null = null;
            let lastError: any = null;

            for (const endpoint of rpcEndpoints) {
                try {
                    log(`Attempting to connect to RPC endpoint: ${endpoint}`, "blockchain");
                    const provider = new ethers.JsonRpcProvider(endpoint, undefined, {
                        staticNetwork: true
                    });

                    const blockNumber = await Promise.race([
                        provider.getBlockNumber(),
                        new Promise<never>((_, reject) => 
                            setTimeout(() => reject(new Error('Connection timeout')), 10000)
                        )
                    ]);
                    
                    log(`Successfully connected to ${endpoint}, block number: ${blockNumber}`, "blockchain");
                    connectedProvider = provider;
                    break;
                } catch (error) {
                    log(`Failed to connect to ${endpoint}: ${error}`, "blockchain-warn");
                    lastError = error;
                    continue;
                }
            }

            if (!connectedProvider) {
                throw new Error(`Failed to connect to any RPC endpoint. Last error: ${lastError}`);
            }

            this.provider = connectedProvider;
            this.relayerWallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);

            const contractConfig = {
                address: config.repoRewardsContractAddress.replace('xdc', '0x'),
                abi: UnifiedRewardsABI,
                signerOrProvider: this.relayerWallet
            };

            const forwarderConfig = {
                address: config.forwarderContractAddress.replace('xdc', '0x'),
                abi: CustomForwarderABI,
                signerOrProvider: this.relayerWallet
            };
            
            const tokenConfig = {
                address: config.roxnTokenAddress.replace('xdc', '0x'),
                abi: ROXNTokenABI,
                signerOrProvider: this.relayerWallet
            };

            if (!config.proofOfComputeContractAddress) {
                throw new Error("PROOF_OF_COMPUTE_CONTRACT_ADDRESS is not set in the environment variables.");
            }

            const proofOfComputeConfig = {
                address: config.proofOfComputeContractAddress.replace('xdc', '0x'),
                abi: ProofOfComputeABI,
                signerOrProvider: this.relayerWallet
            };

            this.contract = new ethers.Contract(
                contractConfig.address,
                contractConfig.abi,
                contractConfig.signerOrProvider
            ) as ExtendedContract;

            this.forwarderContract = new ethers.Contract(
                forwarderConfig.address,
                forwarderConfig.abi,
                forwarderConfig.signerOrProvider
            );
            
            this.tokenContract = new ethers.Contract(
                tokenConfig.address,
                tokenConfig.abi,
                tokenConfig.signerOrProvider
            ) as TokenContract;

            this.proofOfComputeContract = new ethers.Contract(
                proofOfComputeConfig.address,
                proofOfComputeConfig.abi,
                proofOfComputeConfig.signerOrProvider
            ) as ProofOfComputeContract;

            // Initialize USDC token (USDC rewards are now handled by main DualCurrencyRepoRewards contract)
            if (config.usdcTokenAddress) {
                this.usdcTokenContract = new ethers.Contract(
                    config.usdcTokenAddress.replace('xdc', '0x'),
                    ROXNTokenABI, // Same ERC20 interface
                    this.relayerWallet
                ) as TokenContract;
                
                log(`USDC Token initialized at ${this.usdcTokenContract.target}`, "blockchain");
            } else {
                log(`USDC token not configured - skipping USDC support`, "blockchain-warn");
            }

            log(`Unified DualCurrencyRepoRewards contract initialized at ${this.contract.target}`, "blockchain");
            log(`ProofOfCompute contract initialized at ${this.proofOfComputeContract.target}`, "blockchain");

            this.provider.getNetwork().then(async network => {
                log(`Connected to network: chainId=${network.chainId}`, "blockchain");
                try {
                    await this.initializeContractParameters();
                } catch (paramError) {
                    log(`Warning: Failed to initialize contract parameters: ${paramError}`, "blockchain");
                }
                log("Blockchain service initialized successfully", "blockchain");
            });
        } catch (error: any) {
            log(`Failed to initialize provider: ${error.message}`, "blockchain");
            throw error;
        }
    }

    private getWallet(privateKey: string): ethers.Wallet {
        return new ethers.Wallet(privateKey, this.provider);
    }

    async registerUser(username: string, githubId: number, typeOfUser: string, userAddress: string) {
        try {
            log(`Registering user ${username} (${userAddress}) as ${typeOfUser}`, "blockchain");
            const ethAddress = userAddress.replace('xdc', '0x');
            return await this.registerUserOnChain(ethAddress, username, typeOfUser);
        } catch (error: any) {
            log(`Failed to register user: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async registerUserOnChain(userAddress: string, username: string, role: string) {
        try {
            const ethUserAddress = userAddress.replace('xdc', '0x');
            log(`Registering user address: ${ethUserAddress}`, "blockchain");
            
            const networkGasPrice = await this.provider.getFeeData();
            const gasPrice = networkGasPrice.gasPrice! * BigInt(120) / BigInt(100);
            
            log(`Network gas price: ${ethers.formatUnits(networkGasPrice.gasPrice!, 'gwei')} gwei`, "blockchain");
            log(`Using gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`, "blockchain");
            
            const data = this.contract.interface.encodeFunctionData('registerUser', [
                ethUserAddress,
                username,
                role
            ]);

            const unsignedTx = {
                to: this.contract.target as string,
                data: data,
                gasPrice: gasPrice,
                gasLimit: BigInt(300000),
                chainId: 50
            };

            const nonce = await this.provider.getTransactionCount(this.relayerWallet.address);
            (unsignedTx as any)['nonce'] = nonce;

            const relayerBalance = await this.provider.getBalance(this.relayerWallet.address);
            const estimatedCost = gasPrice * unsignedTx.gasLimit;
            
            log(`Relayer balance: ${ethers.formatEther(relayerBalance)} XDC`, "blockchain");
            log(`Estimated cost: ${ethers.formatEther(estimatedCost)} XDC`, "blockchain");
            
            if (relayerBalance < estimatedCost) {
                throw new Error(`Insufficient relayer balance. Need ${ethers.formatEther(estimatedCost)} XDC, have ${ethers.formatEther(relayerBalance)} XDC`);
            }

            const response = await this.relayerWallet.sendTransaction(unsignedTx);
            log(`Transaction sent: ${response.hash}`, "blockchain");
            
            const receipt = await response.wait();
            if (receipt) {
                log(`Transaction confirmed in block ${receipt.blockNumber}`, "blockchain");
            } else {
                log(`Transaction confirmed but receipt was null`, "blockchain");
            }

            return receipt;
        } catch (error: any) {
            log(`Failed to register user: ${error.message}`, "blockchain");
            throw error;
        }
    }

    private async getUserWalletReferenceId(userId: number): Promise<string> {
        try {
            const user = await storage.getUserById(userId);
            if (!user || !user.walletReferenceId) {
                throw new Error('User wallet not found');
            }
            return user.walletReferenceId;
        } catch (error: any) {
            log(`Failed to get user wallet reference ID: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async addPoolManager(repoId: number, poolManager: string, username: string, githubId: number, userId: number): Promise<ethers.TransactionReceipt | null> {
        try {
            const user = await storage.getUserById(userId);
            if (!user) {
                throw new Error('User not found');
            }
            
            if (!user.xdcWalletAddress) {
                throw new Error('User wallet address not found');
            }
            
            log(`Adding pool manager ${username} (${poolManager}) using meta-transaction`, "blockchain");
            
            const addManagerData = this.contract.interface.encodeFunctionData(
                'addPoolManager', 
                [repoId, poolManager, username, githubId]
            );
            
            const { request, signature } = await this.prepareMetaTransaction(
                userId,
                this.contract.target as string,
                addManagerData,
                BigInt(200000)
            );
            
            log(`Sending addPoolManager meta-transaction for repository ${repoId}`, "blockchain");
            const tx = await this.executeMetaTransaction(request, signature, BigInt(400000));
            
            const receipt = await tx.wait();
            
            if (!receipt) {
                throw new Error('Transaction failed');
            }
            
            log(`Pool manager added. TX: ${tx.hash}`, "blockchain");
            return receipt;
        } catch (error: any) {
            log(`Failed to add pool manager: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async allocateIssueReward(
        repoId: number,
        issueId: number,
        reward: string,
        currencyType: 'XDC' | 'ROXN' | 'USDC',
        userId: number
    ): Promise<AllocateRewardResponse> {
        try {
            const user = await storage.getUserById(userId);
            if (!user) {
                throw new Error('User not found');
            }
            
            if (!user.xdcWalletAddress) {
                throw new Error('User wallet address not found');
            }
            
            const userAddress = user.xdcWalletAddress.replace('xdc', '0x');
            
            // All currencies (XDC, ROXN, USDC) now use the main DualCurrencyRepoRewards contract
            // Convert amount based on currency decimals
            const rewardBigInt = currencyType === 'USDC' 
                ? ethers.parseUnits(reward, 6)  // USDC has 6 decimals
                : ethers.parseEther(reward);     // XDC and ROXN have 18 decimals
            
            const currencyTypeEnum = currencyType === 'ROXN' ? 1 : (currencyType === 'USDC' ? 2 : 0); // 0=XDC, 1=ROXN, 2=USDC
            
            log(`Ensuring user ${user.username} (${userAddress}) has enough XDC for allocateIssueReward transaction`, "blockchain");
            const gasWasSubsidized = await this.ensureUserHasGas(userAddress);
            
            if (gasWasSubsidized) {
                log(`Gas was subsidized, waiting for network to stabilize...`, "blockchain");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
            if (!user.walletReferenceId) {
                throw new Error('User wallet reference ID not found');
            }
            
            const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userPrivateKey.privateKey, this.provider);
            
            const contractWithSigner = this.contract.connect(userWallet) as ExtendedContract;
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice! * BigInt(120) / BigInt(100);
            
            log(`Allocating reward of ${reward} ${currencyType} for issue ${issueId} in repo ${repoId}`, "blockchain");
            
            const contractInterface = new ethers.Interface(UnifiedRewardsABI);
            const data = contractInterface.encodeFunctionData(
                'allocateIssueReward',
                [repoId, issueId, rewardBigInt, currencyTypeEnum]
            );
            
            const estimatedGas = await this.provider.estimateGas({
                from: userWallet.address,
                to: this.contract.target,
                data: data,
                gasPrice
            });
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);
            
            const transactionRequest = {
                to: this.contract.target,
                data: data,
                gasPrice: gasPrice,
                gasLimit: safeGasLimit
            };
            
            log(`Sending allocateIssueReward transaction with gasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} gwei, gasLimit: ${safeGasLimit}`, "blockchain");
            const tx = await userWallet.sendTransaction(transactionRequest);
            
            log(`Waiting for allocateIssueReward transaction to be confirmed...`, "blockchain");
            const receipt = await tx.wait();
            
            if (!receipt) {
                throw new Error('Transaction failed');
            }
            
            log(`Reward allocated. TX: ${tx.hash}`, "blockchain");
            
            return {
                transactionHash: tx.hash,
                blockNumber: receipt.blockNumber
            };
        } catch (error: any) {
            log(`Failed to allocate XDC reward: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async addXDCFundToRepository(repoId: number, amountXdc: string, userId?: number): Promise<ethers.TransactionResponse> {
        try {
            const amountWei = ethers.parseEther(amountXdc);
            
            if (!userId) {
                throw new Error('User ID is required');
            }
            
            const user = await storage.getUserById(userId);
            if (!user) {
                throw new Error('User not found');
            }
            
            if (user.role !== 'poolmanager') {
                throw new Error('Only pool managers can add funds');
            }
            
            if (!user.xdcWalletAddress || !user.walletReferenceId) {
                throw new Error('User wallet address or reference ID not found');
            }
            
            const userAddress = user.xdcWalletAddress.replace('xdc', '0x');
            log(`User ${user.username} (ID: ${userId}) is adding ${amountXdc} XDC to repository ${repoId}`, "blockchain");
            
            log(`Ensuring user ${user.username} (${userAddress}) has enough XDC for gas for addFundToRepository transaction`, "blockchain");
            const gasWasSubsidized = await this.ensureUserHasGas(user.xdcWalletAddress, amountXdc);
            if (gasWasSubsidized) {
                log(`Gas was subsidized for user ${user.username}, waiting 5s...`, "blockchain");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
            const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userPrivateKey.privateKey, this.provider);
            
            const contractWithSigner = this.contract.connect(userWallet) as ExtendedContract;
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice ? feeData.gasPrice * BigInt(120) / BigInt(100) : undefined;
            
            const estimateGasFunc = contractWithSigner.getFunction('addXDCFundToRepository');
            const estimatedGas = await estimateGasFunc.estimateGas(repoId, { value: amountWei });
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);

            log(`User ${user.username} calling addXDCFundToRepository for repository ${repoId} with ${amountXdc} XDC`, "blockchain");
            const txResponse: ethers.TransactionResponse = await contractWithSigner.addXDCFundToRepository(repoId, {
                value: amountWei,
                gasPrice: gasPrice,
                gasLimit: safeGasLimit
            });

            const receipt = await txResponse.wait();

            if (!receipt) {
                throw new Error('Transaction failed to confirm');
            }

            log(`Funds added to repository ${repoId}. Amount: ${amountXdc} XDC. TX: ${txResponse.hash}`, "blockchain");

            await this.recordTransactionTrace(
                userId,
                'fund_repository',
                repoId,
                txResponse.hash,
                {
                    amountXdc: amountXdc,
                    userAddress: user.xdcWalletAddress,
                    timestamp: new Date().toISOString()
                }
            );

            return txResponse;
        } catch (error) {
            log(`Error in addFundToRepository: ${error}`, "blockchain");
            throw error;
        }
    }

    private async getWalletSecret(walletReferenceId: string): Promise<{ privateKey: string }> {
        try {
            return await transactionService.getWalletSecret(walletReferenceId);
        } catch (error) {
            console.error('Error getting wallet secret:', error);
            throw new Error('Failed to retrieve wallet secret');
        }
    }

    private async prepareMetaTransaction(
        userId: number,
        targetContract: string,
        data: string,
        gasEstimate: bigint = BigInt(300000)
    ): Promise<{request: any, signature: string}> {
        const user = await storage.getUserById(userId);
        if (!user || !user.xdcWalletAddress || !user.walletReferenceId) {
            throw new Error('User details not found');
        }
        
        const userAddress = user.xdcWalletAddress.replace('xdc', '0x');
        
        const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
        const userWallet = new ethers.Wallet(userPrivateKey.privateKey);
        
        const forwardRequest = {
            from: userAddress,
            to: targetContract,
            value: 0,
            gas: gasEstimate,
            nonce: await this.forwarderContract.getNonce(userAddress),
            data: data
        };
        
        const domain = {
            name: 'CustomForwarder',
            version: '0.0.1',
            chainId: 50,
            verifyingContract: this.forwarderContract.target as string
        };
        
        const types = {
            ForwardRequest: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'gas', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'data', type: 'bytes' }
            ]
        };
        
        const signature = await userWallet.signTypedData(domain, types, forwardRequest);
        
        return { request: forwardRequest, signature };
    }

    async ensureUserHasGas(userAddress: string, transactionAmount: string = "0", minGasAmount: string = "0.005"): Promise<boolean> {
        try {
            const ethUserAddress = userAddress.replace('xdc', '0x');
            
            const currentBalance = await this.provider.getBalance(ethUserAddress);
            const minGasAmountWei = ethers.parseEther(minGasAmount);
            
            let transactionAmountWei = BigInt(0);
            if (transactionAmount && transactionAmount !== "0") {
                transactionAmountWei = ethers.parseEther(transactionAmount);
            }
            
            const totalRequired = transactionAmountWei + minGasAmountWei;
            
            log(`User ${ethUserAddress} has ${ethers.formatEther(currentBalance)} XDC`, "blockchain");
            log(`Transaction requires: ${transactionAmount} XDC + ${minGasAmount} XDC gas = ${ethers.formatEther(totalRequired)} XDC total`, "blockchain");
            
            if (currentBalance >= totalRequired) {
                log(`User has enough XDC for transaction + gas (${ethers.formatEther(currentBalance)} XDC available)`, "blockchain");
                return false;
            }
            
            if (currentBalance < minGasAmountWei) {
                const errorMsg = `Insufficient XDC balance. You need at least ${minGasAmount} XDC for transaction fees. Please add more XDC to your wallet and try again.`;
                log(errorMsg, "blockchain");
                throw new Error(errorMsg);
            } else {
                const maxPossibleSend = ethers.formatEther(currentBalance - minGasAmountWei);
                const errorMsg = `Insufficient XDC balance for this transaction. You have ${ethers.formatEther(currentBalance)} XDC, but need to keep at least ${minGasAmount} XDC for gas fees. The maximum you can send is ${maxPossibleSend} XDC.`;
                log(errorMsg, "blockchain");
                throw new Error(errorMsg);
            }
            
        } catch (error: any) {
            log(`Failed to check user gas: ${error.message}`, "blockchain");
            throw error;
        }
    }

    private async executeMetaTransaction(
        request: any,
        signature: string,
        gasLimit: bigint = BigInt(500000)
    ): Promise<ethers.TransactionResponse> {
        const forwarderInterface = new ethers.Interface(CustomForwarderABI);
        
        const data = forwarderInterface.encodeFunctionData(
            'execute',
            [request, signature]
        );
        
        const unsignedTx = {
            to: this.forwarderContract.target as string,
            data: data,
            gasLimit: Number(gasLimit),
            chainId: 50
        };
        
        const tx = await this.relayerWallet.sendTransaction(unsignedTx);
        
        return tx;
    }

    async approveTokensForContract(amount: string, userId: number, spenderAddress: string): Promise<ethers.TransactionResponse> {
        try {
            const amountWei = ethers.parseEther(amount);
            
            const user = await storage.getUserById(userId);
            if (!user) {
                throw new Error('User not found');
            }
            
            if (!user.xdcWalletAddress) {
                throw new Error('User wallet address not found');
            }
            
            const userAddress = user.xdcWalletAddress.replace('xdc', '0x');
            
            log(`Ensuring user ${user.username} (${userAddress}) has enough XDC for approval transaction`, "blockchain");
            const gasWasSubsidized = await this.ensureUserHasGas(userAddress);
            
            if (gasWasSubsidized) {
                log(`Gas was subsidized, waiting for network to stabilize...`, "blockchain");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
            if (!user.walletReferenceId) {
                throw new Error('User wallet reference ID not found');
            }
            
            const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userPrivateKey.privateKey, this.provider);
            
            log(`User ${user.username} approving ${amount} ROXN tokens for spender contract ${spenderAddress}`, "blockchain");
            
            const tokenContractInterface = new ethers.Interface(ROXNTokenABI);
            const tokenContractWithSigner = new ethers.Contract(
                this.tokenContract.target as string,
                tokenContractInterface,
                userWallet
            );
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice! * BigInt(120) / BigInt(100);
            
            const estimatedGas = await tokenContractWithSigner.approve.estimateGas(spenderAddress, amountWei);
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);
            
            log(`Sending approval transaction with gasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} gwei, gasLimit: ${safeGasLimit}`, "blockchain");
            const tx = await tokenContractWithSigner.approve(spenderAddress, amountWei, {
                gasPrice,
                gasLimit: safeGasLimit
            });
            
            log(`Waiting for approval transaction to be confirmed...`, "blockchain");
            const receipt = await tx.wait();
            
            if (!receipt) {
                throw new Error('Transaction failed');
            }
            
            log(`Token approval completed. TX: ${tx.hash}`, "blockchain");
            
            return tx;
        } catch (error) {
            log(`Error in approveTokensForContract: ${error}`, "blockchain");
            throw error;
        }
    }

    async distributeReward(repoId: number, issueId: number, contributorAddress: string, userId: number): Promise<ethers.TransactionReceipt | null> {
        try {
            const user = await storage.getUserById(userId);
            if (!user) {
                throw new Error('User not found');
            }
            
            if (!user.xdcWalletAddress) {
                throw new Error('User wallet address not found');
            }
            
            const userAddress = user.xdcWalletAddress.replace('xdc', '0x');
            
            const ethContributorAddress = contributorAddress.replace('xdc', '0x');
            log(`Converting contributor address from ${contributorAddress} to ${ethContributorAddress}`, "blockchain");
            
            log(`Ensuring user ${user.username} (${userAddress}) has enough XDC for distributeReward transaction`, "blockchain");
            const gasWasSubsidized = await this.ensureUserHasGas(userAddress);
            
            if (gasWasSubsidized) {
                log(`Gas was subsidized, waiting for network to stabilize...`, "blockchain");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
            if (!user.walletReferenceId) {
                throw new Error('User wallet reference ID not found');
            }
            
            const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userPrivateKey.privateKey, this.provider);
            
            const data = this.contract.interface.encodeFunctionData(
                'distributeReward', 
                [repoId, issueId, ethContributorAddress]
            );
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice! * BigInt(120) / BigInt(100);
            
            const estimatedGas = await this.provider.estimateGas({
                from: userWallet.address,
                to: this.contract.target,
                data: data,
                gasPrice
            });
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);
            
            const transactionRequest = {
                to: this.contract.target,
                data: data,
                gasPrice: gasPrice,
                gasLimit: safeGasLimit
            };
            
            log(`Sending distributeReward transaction with gasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} gwei, gasLimit: ${safeGasLimit}`, "blockchain");
            const tx = await userWallet.sendTransaction(transactionRequest);
            
            log(`Waiting for distributeReward transaction to be confirmed...`, "blockchain");
            const receipt = await tx.wait();
            
            if (!receipt) {
                throw new Error('Transaction failed');
            }
            
            log(`XDC Reward distributed. TX: ${tx.hash}`, "blockchain");
            return receipt;
        } catch (error: any) {
            log(`Failed to distribute XDC reward: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async getPoolManager(walletAddress: string): Promise<any> {
        return await this.contract.getPoolManager(walletAddress);
    }

    async getContributor(walletAddress: string): Promise<any> {
        return await this.contract.getContributor(walletAddress);
    }

    async getRepository(repoId: number): Promise<any> {
        try {
            if (!this.contract || !this.contract.target) {
                log(`Contract not properly initialized when calling getRepository`, "blockchain-ERROR");
                throw new Error("Contract not initialized");
            }

            log(`Calling getRepository on contract ${this.contract.target} for repoId ${repoId}`, "blockchain-debug");

            const rawResult = await this.contract.getRepository(repoId);
            if (!rawResult || !Array.isArray(rawResult) || (rawResult.length !== 5 && rawResult.length !== 6)) {
                log(`Contract returned empty data for repoId ${repoId} - repository may not be initialized`, "blockchain-warn");
                return {
                    xdcPoolRewards: "0.0",
                    roxnPoolRewards: "0.0",
                    usdcPoolRewards: "0.0",
                    issues: [],
                    poolManagers: [],
                    contributors: []
                } as UnifiedPoolInfo;
            }

            // Handle both old (5 values) and new (6 values) contract versions
            let poolManagers, contributors, poolRewardsXDC, poolRewardsROXN, poolRewardsUSDC, issues;
            if (rawResult.length === 5) {
                // Old contract without USDC
                [poolManagers, contributors, poolRewardsXDC, poolRewardsROXN, issues] = rawResult;
                poolRewardsUSDC = BigInt(0);
            } else {
                // New contract with USDC
                [poolManagers, contributors, poolRewardsXDC, poolRewardsROXN, poolRewardsUSDC, issues] = rawResult as DualCurrencyRepositoryDetailsTuple;
            }
            
            // USDC data is now included in the main contract's getRepository response (poolRewardsUSDC already set above)
            
            if ((!poolManagers || poolManagers.length === 0) && 
                (!contributors || contributors.length === 0) && 
                poolRewardsXDC === BigInt(0) && 
                poolRewardsROXN === BigInt(0) &&
                poolRewardsUSDC === BigInt(0)) {
                log(`Repository ${repoId} exists but is not initialized (no managers, no funds)`, "blockchain-info");
                return {
                    xdcPoolRewards: "0.0",
                    roxnPoolRewards: "0.0",
                    usdcPoolRewards: "0.0",
                    issues: [],
                    poolManagers: [],
                    contributors: []
                } as UnifiedPoolInfo;
            }

            const formattedIssues: IssueBountyDetails[] = (issues as any[]).map((issueFromContract: any) => {
                const amountFromContract = issueFromContract.rewardAmount ?? BigInt(0);
                const isRoxn = issueFromContract.isRoxnReward ?? false;
                
                let xdcAmountStr = "0.0";
                let roxnAmountStr = "0.0";

                if (isRoxn) {
                    roxnAmountStr = ethers.formatEther(amountFromContract);
                } else {
                    xdcAmountStr = ethers.formatEther(amountFromContract);
                }

                return {
                    issueId: (issueFromContract.issueId ?? BigInt(0)).toString(),
                    status: this.mapStatus(issueFromContract.status ?? -1),
                    xdcAmount: xdcAmountStr,
                    roxnAmount: roxnAmountStr,
                    isRoxn: isRoxn 
                };
            });

            return {
                xdcPoolRewards: ethers.formatEther(poolRewardsXDC),
                roxnPoolRewards: ethers.formatEther(poolRewardsROXN),
                usdcPoolRewards: ethers.formatUnits(poolRewardsUSDC, 6),
                issues: formattedIssues,
                poolManagers: poolManagers.map(addr => addr.toLowerCase()),
                contributors: contributors.map(addr => addr.toLowerCase()),
            } as UnifiedPoolInfo;
        } catch (error: any) {
            log(`Failed to get repository details for repoId ${repoId}: ${error.message}`, "blockchain");
            
            if (error.code === 'BAD_DATA' && error.value === '0x') {
                log(`Repository ${repoId} appears to not exist in the contract - returning empty structure`, "blockchain-info");
            }
            
            return {
                xdcPoolRewards: "0.0",
                roxnPoolRewards: "0.0",
                usdcPoolRewards: "0.0",
                issues: [],
                poolManagers: [],
                contributors: []
            } as UnifiedPoolInfo;
        }
    }

    async getIssueRewards(repoId: number, issueIds: number[]): Promise<IssueBountyDetails[]> {
        try {
            log(`Fetching issue rewards for repo ${repoId}, issues: ${issueIds.join(',')}`, "blockchain");
            
            if (issueIds.length === 0) {
                return [];
            }
            
            // Call contract.getIssueRewards to get Issue structs
            let issuesFromContract: any[];
            try {
                issuesFromContract = await this.contract.getIssueRewards(repoId, issueIds) as any[];
            } catch (decodeError: any) {
                // If decode fails, it means no bounties exist for these issues - return empty array
                if (decodeError.code === 'BAD_DATA' || decodeError.message?.includes('could not decode')) {
                    log(`No bounties found for repo ${repoId}, issues ${issueIds.join(',')} (decode failed)`, "blockchain");
                    return [];
                }
                throw decodeError;
            }
            
            if (!Array.isArray(issuesFromContract) || issuesFromContract.length === 0) {
                log(`Empty bounty data for repo ${repoId}`, "blockchain");
                return [];
            }
            
            // Fetch currency types for all issues
            const results: IssueBountyDetails[] = [];
            
            for (let i = 0; i < issuesFromContract.length; i++) {
                const issueFromContract = issuesFromContract[i];
                const issueId = issueIds[i];
                const amountFromContract = issueFromContract.rewardAmount ?? BigInt(0);
                const isRoxn = issueFromContract.isRoxnReward ?? false;
                
                // Skip if no reward amount
                if (amountFromContract === BigInt(0)) {
                    continue;
                }
                
                // Query the currency type from the contract mapping
                let currencyType = 0; // Default to XDC
                try {
                    const currencyTypeResult = await this.contract.issueCurrencyTypes(repoId, issueId);
                    currencyType = Number(currencyTypeResult);
                    log(`Issue ${issueId}: currencyType=${currencyType}, amount=${amountFromContract.toString()}, isRoxn=${isRoxn}`, "blockchain");
                } catch (err: any) {
                    log(`Could not fetch currency type for repo ${repoId} issue ${issueId}: ${err.message}, defaulting to XDC`, "blockchain-warn");
                }
                
                // Determine amounts based on currency type (0=XDC, 1=ROXN, 2=USDC)
                let xdcAmountStr = "0.0";
                let roxnAmountStr = "0.0";
                let usdcAmountStr = "0.0";
                
                // Convert to number and use == for loose comparison
                const currencyTypeNum = Number(currencyType);
                log(`Currency type check: currencyTypeNum=${currencyTypeNum}, type=${typeof currencyTypeNum}`, "blockchain");
                
                if (currencyTypeNum == 2) {
                    // USDC (6 decimals)
                    usdcAmountStr = ethers.formatUnits(amountFromContract, 6);
                    log(`Formatted as USDC: ${usdcAmountStr}`, "blockchain");
                } else if (currencyTypeNum == 1 || isRoxn) {
                    // ROXN (18 decimals)
                    roxnAmountStr = ethers.formatEther(amountFromContract);
                    log(`Formatted as ROXN: ${roxnAmountStr}`, "blockchain");
                } else {
                    // XDC (18 decimals)
                    xdcAmountStr = ethers.formatEther(amountFromContract);
                    log(`Formatted as XDC: ${xdcAmountStr}`, "blockchain");
                }
                
                results.push({
                    issueId: issueId.toString(),
                    status: this.mapStatus(issueFromContract.status ?? 0),
                    xdcAmount: xdcAmountStr,
                    roxnAmount: roxnAmountStr,
                    usdcAmount: usdcAmountStr,
                    isRoxn: isRoxn
                });
            }
            
            log(`Retrieved ${results.length} issue bounties for repo ${repoId}`, "blockchain");
            return results;
            
        } catch (error: any) {
            const errorMsg = error.message || 'Unknown error';
            log(`Failed to get issue rewards: ${errorMsg}`, "blockchain-ERROR");
            return [];
        }
    }

    async checkUserType(userAddress: string): Promise<[string, string]> {
        return await this.contract.checkUserType(userAddress);
    }

    async getUserWalletByUsername(username: string): Promise<string> {
        return await this.contract.getUserWalletByUsername(username);
    }

    async getRepositoryRewards(repoId: number): Promise<{rewardsXDC: string, rewardsROXN: string}> {
        const [xdc, roxn] = await this.contract.getRepositoryRewards(repoId);
        return {
            rewardsXDC: ethers.formatEther(xdc),
            rewardsROXN: ethers.formatEther(roxn)
        };
    }

    async getUserRole(address: string): Promise<string> {
        try {
            const role = await this.contract.getUserRole(address);
            return role;
        } catch (error) {
            log(`Error getting user role: ${error}`, "blockchain");
            throw error;
        }
    }

    async getPoolManagers(): Promise<string[]> {
        try {
            const managers = await this.contract.getPoolManagers();
            return managers;
        } catch (error) {
            log(`Error getting pool managers: ${error}`, "blockchain");
            throw error;
        }
    }

    async getWalletInfo(userId: string | number) {
        try {
            log(`Fetching wallet info for user ${userId}`, "blockchain");
            const wallet = await storage.getWallet(userId.toString());
            
            if (!wallet) {
                throw new Error('Wallet not found');
            }
            
            const walletAddressLower = wallet.address.toLowerCase();
            if (!walletAddressLower.startsWith('xdc') && !walletAddressLower.startsWith('0x')) {
                log(`Invalid wallet address format detected for user ${userId}`, 'blockchain');
                throw new Error('Invalid wallet address format');
            }
            
            const ethAddress = walletAddressLower.startsWith('xdc') ? walletAddressLower.replace('xdc', '0x') : walletAddressLower;
            
            let balance: bigint;
            try {
                const balanceHex = await this.provider.send("eth_getBalance", [ethAddress, "latest"]);
                balance = BigInt(balanceHex || "0x0");
            } catch (rpcError) {
                log(`eth_getBalance RPC failed: ${rpcError}; falling back to provider.getBalance`, "blockchain");
                balance = await this.provider.getBalance(ethAddress);
            }
            
            log(`Address: ${ethAddress}, Balance: ${balance.toString()}`, "blockchain");
            
            let tokenBalance = BigInt(0);
            try {
                tokenBalance = await this.getTokenBalance(wallet.address);
            } catch (tokenError) {
                log(`Error getting token balance: ${tokenError}`, "blockchain");
            }
            
            return {
                address: wallet.address,
                balance: balance,
                tokenBalance: tokenBalance
            };
        } catch (error: any) {
            log(`Failed to get wallet info: ${error.message}`, "blockchain");
            return {
                address: "",
                balance: BigInt(0),
                tokenBalance: BigInt(0)
            };
        }
    }

    async getRecentTransactions(userId: string | number, limit: number = 10): Promise<Transaction[]> {
        try {
            log(`Getting recent transactions for user ${userId}`, "blockchain");
            const wallet = await storage.getWallet(userId.toString());
            
            if (!wallet) {
                throw new Error('Wallet not found');
            }
            
            const walletAddressLower = wallet.address.toLowerCase();
            if (!walletAddressLower.startsWith('xdc') && !walletAddressLower.startsWith('0x')) {
                log(`Invalid wallet address format detected for user ${userId}`, 'blockchain');
                throw new Error('Invalid wallet address format');
            }
            
            const ethAddress = walletAddressLower.startsWith('xdc') ? walletAddressLower.replace('xdc', '0x') : walletAddressLower;
            
            const currentBlock = await this.provider.getBlockNumber();
            
            const transactions: Transaction[] = [];
            
            const blocksToScan = Math.min(100, currentBlock);
            
            const timeout = 30000;
            const scanTimeout = setTimeout(() => {
                log(`Transaction scan timed out after ${timeout}ms`, "blockchain");
            }, timeout);
            
            try {
                const promises = [];
                
                for (let i = 0; i < blocksToScan && transactions.length < limit; i++) {
                    const blockNumber = currentBlock - i;
                    promises.push((async () => {
                        try {
                            const block = await this.provider.getBlock(blockNumber);
                            
                            if (!block || !block.transactions || block.transactions.length === 0) {
                                return;
                            }
                            
                            const txsToCheck = block.transactions.slice(0, 20);
                            
                            for (const txHash of txsToCheck) {
                                if (typeof txHash !== 'string') continue;
                                
                                try {
                                    const tx = await this.provider.getTransaction(txHash);
                                    
                                    if (!tx) continue;
                                    
                                    const txTo = tx.to ? tx.to.toLowerCase() : '';
                                    const txFrom = tx.from ? tx.from.toLowerCase() : '';
                                    
                                    if (txTo === ethAddress.toLowerCase() ||
                                        txFrom === ethAddress.toLowerCase()) {

                                        const txValue = tx.value ? tx.value.toString() : '0';

                                        // Check for token transfers by getting transaction receipt
                                        let tokenSymbol: string | undefined;
                                        let tokenAmount: string | undefined;
                                        let actualFrom = tx.from || '';
                                        let actualTo = tx.to || '';
                                        let isIncoming = txTo === ethAddress.toLowerCase();

                                        // ERC-20 Transfer event topic
                                        const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
                                        const roxnAddress = config.roxnTokenAddress.toLowerCase();
                                        const usdcAddress = config.usdcXdcAddress.toLowerCase();

                                        try {
                                            const receipt = await this.provider.getTransactionReceipt(tx.hash);
                                            if (receipt && receipt.logs) {
                                                for (const log of receipt.logs) {
                                                    // Check if this is a Transfer event
                                                    if (log.topics[0] === TRANSFER_TOPIC) {
                                                        const logAddress = log.address.toLowerCase();

                                                        // Check if it's ROXN or USDC token
                                                        if (logAddress === roxnAddress || logAddress === usdcAddress) {
                                                            // Decode Transfer event: Transfer(from, to, value)
                                                            const from = '0x' + log.topics[1].slice(26);
                                                            const to = '0x' + log.topics[2].slice(26);
                                                            const value = BigInt(log.data);

                                                            // Check if user is involved in this transfer
                                                            if (from.toLowerCase() === ethAddress.toLowerCase() ||
                                                                to.toLowerCase() === ethAddress.toLowerCase()) {

                                                                tokenSymbol = logAddress === roxnAddress ? 'ROXN' : 'USDC';
                                                                // Both ROXN and USDC use 18 decimals
                                                                tokenAmount = ethers.formatEther(value);
                                                                actualFrom = from;
                                                                actualTo = to;
                                                                isIncoming = to.toLowerCase() === ethAddress.toLowerCase();
                                                                break; // Found the relevant transfer
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (receiptError) {
                                            // If we can't get receipt, continue with native XDC info
                                            log(`Error getting receipt for ${tx.hash}: ${receiptError}`, "blockchain");
                                        }

                                        // If no token transfer found and native value is 0, skip this transaction
                                        if (!tokenSymbol && txValue === '0') {
                                            continue;
                                        }

                                        // Set defaults for native XDC transfers
                                        if (!tokenSymbol && BigInt(txValue) > BigInt(0)) {
                                            tokenSymbol = 'XDC';
                                            tokenAmount = ethers.formatEther(txValue);
                                        }

                                        const txDetails: Transaction = {
                                            hash: tx.hash,
                                            blockNumber: block.number,
                                            from: actualFrom,
                                            to: actualTo,
                                            value: txValue,
                                            timestamp: block.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : new Date().toISOString(),
                                            confirmations: currentBlock - block.number + 1,
                                            isIncoming: isIncoming,
                                            status: (currentBlock - block.number + 1) >= 12 ? 'confirmed' as const : 'pending' as const,
                                            tokenSymbol,
                                            tokenAmount
                                        };

                                        transactions.push(txDetails);

                                        if (transactions.length >= limit) {
                                            return;
                                        }
                                    }
                                } catch (txError) {
                                    log(`Error processing transaction ${txHash}: ${txError}`, "blockchain");
                                }
                            }
                        } catch (blockError) {
                            log(`Error scanning block ${blockNumber}: ${blockError}`, "blockchain");
                        }
                    })());
                }
                
                await Promise.race([
                    Promise.all(promises),
                    new Promise(resolve => setTimeout(resolve, timeout - 500))
                ]);
            } finally {
                clearTimeout(scanTimeout);
            }
            
            return transactions;
        } catch (error: any) {
            log(`Failed to get recent transactions: ${error.message}`, "blockchain");
            return [];
        }
    }
    
    async recordTransactionTrace(
        userId: number, 
        action: string, 
        repoId: number | null = null,
        txHash: string | null = null,
        data: Record<string, any> = {}
    ): Promise<void> {
        try {
            const timestamp = new Date().toISOString();
            
            const logEntry = {
                timestamp,
                userId,
                action,
                repoId,
                txHash,
                ...data
            };
            
            log(`[AUDIT] ${JSON.stringify(logEntry)}`, 'blockchain');
            
        } catch (error) {
            log(`Error recording transaction trace: ${error}`, 'blockchain');
        }
    }
    
    async getTokenBalance(address: string): Promise<bigint> {
        try {
            const ethAddress = address.replace('xdc', '0x');
            log(`Getting token balance for ${ethAddress}`, "blockchain");
            
            if (!this.tokenContract) {
                log("Token contract not initialized", "blockchain");
                return BigInt(0);
            }
            
            try {
                const data = this.tokenContract.interface.encodeFunctionData('balanceOf', [ethAddress]);
                const result = await this.provider.call({
                    to: this.tokenContract.target as string,
                    data
                });
                
                if (result && result !== '0x') {
                    const decodedResult = this.tokenContract.interface.decodeFunctionResult('balanceOf', result);
                    return decodedResult[0];
                }
                log("Empty result from token contract, returning 0", "blockchain");
                return BigInt(0);
            } catch (rpcError) {
                log(`RPC error getting token balance: ${rpcError}`, "blockchain");
                return BigInt(0);
            }
        } catch (error) {
            log(`Error in getTokenBalance: ${error}`, "blockchain");
            return BigInt(0);
        }
    }
    
    getTokenContract(): TokenContract {
        return this.tokenContract;
    }
    
    getUserWallet(userAddress: string): ethers.Wallet {
        if (!this.userWallets.has(userAddress)) {
            const privateKey = this.generatePrivateKeyForUser(userAddress);
            const wallet = new ethers.Wallet(privateKey, this.provider);
            this.userWallets.set(userAddress, wallet);
        }
        return this.userWallets.get(userAddress)!;
    }
    
    private generatePrivateKeyForUser(userAddress: string): string {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(userAddress + config.privateKeySecret));
        return hash;
    }

    async mintTokensToUser(userId: number, amount: string): Promise<any> {
        try {
            const amountInWei = ethers.parseEther(amount);
            
            await storage.updateUserTokenBalance(userId, Number(ethers.formatEther(amountInWei)));
            
            return { success: true, message: `Minted ${amount} tokens to user ${userId}` };
        } catch (error) {
            console.error('Error minting tokens:', error);
            throw new Error('Failed to mint tokens');
        }
    }
    
    async sendFunds(userId: string | number, recipientAddress: string, amount: bigint): Promise<ethers.TransactionResponse> {
        try {
            const walletReferenceId = await this.getUserWalletReferenceId(Number(userId));
            
            const { privateKey } = await this.getWalletSecret(walletReferenceId);
            
            const userWallet = new ethers.Wallet(privateKey, this.provider);
            
            const gasPrice = await this.provider.getFeeData();
            const adjustedGasPrice = gasPrice.gasPrice ? gasPrice.gasPrice * BigInt(110) / BigInt(100) : undefined;
            
            const nonce = await this.provider.getTransactionCount(userWallet.address);
            
            let normalizedRecipient = recipientAddress;
            
            if (normalizedRecipient.startsWith('xdc')) {
                normalizedRecipient = '0x' + normalizedRecipient.substring(3);
            }
            
            const gasLimit = await this.provider.estimateGas({
                from: userWallet.address,
                to: normalizedRecipient,
                value: amount
            });
            
            const safeGasLimit = gasLimit * BigInt(120) / BigInt(100);
            
            log(`Sending ${ethers.formatEther(amount)} XDC from ${userWallet.address.substring(0, 6)}...${userWallet.address.substring(userWallet.address.length - 4)} to ${normalizedRecipient.substring(0, 6)}...${normalizedRecipient.substring(normalizedRecipient.length - 4)}`, "blockchain");
            
            const tx = await userWallet.sendTransaction({
                to: normalizedRecipient,
                value: amount,
                nonce: nonce,
                gasLimit: safeGasLimit,
                gasPrice: adjustedGasPrice,
                chainId: 50
            });
            
            await this.recordTransactionTrace(
                Number(userId),
                'send_funds',
                null,
                tx.hash,
                {
                    recipient: recipientAddress,
                    amount: ethers.formatEther(amount),
                    gasLimit: safeGasLimit.toString(),
                    gasPrice: adjustedGasPrice ? ethers.formatUnits(adjustedGasPrice, 'gwei') : 'default'
                }
            );
            
            log(`Transaction submitted with hash: ${tx.hash}`, "blockchain");
            
            return tx;
        } catch (error) {
            log(`Error in sendFunds: ${error}`, "blockchain");
            throw error;
        }
    }

    async addROXNFundToRepository(repoId: number, roxnAmount: string, userId: number): Promise<ethers.TransactionResponse | null> {
        try {
            const user = await storage.getUserById(userId);
            if (!user || !user.xdcWalletAddress || !user.walletReferenceId) {
                throw new Error('User details not found for ROXN funding');
            }
            const userWalletPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userWalletPrivateKey.privateKey, this.provider);

            log(`User ${user.username} initiating approval for ${roxnAmount} ROXN to unified rewards contract ${this.contract.target}`, "blockchain");
            await this.approveTokensForContract(roxnAmount, userId, this.contract.target as string);
            
            await new Promise(resolve => setTimeout(resolve, 5000));

            log(`User ${user.username} adding ${roxnAmount} ROXN to repository ${repoId} via unified system`, "blockchain");
            const amountWei = ethers.parseEther(roxnAmount);

            const contractWithSigner = this.contract.connect(userWallet) as ExtendedContract;
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice ? feeData.gasPrice * BigInt(120) / BigInt(100) : undefined;

            const data = contractWithSigner.interface.encodeFunctionData('addROXNFundToRepository', [repoId, amountWei]);
            const estimatedGas = await this.provider.estimateGas({
                from: userWallet.address,
                to: contractWithSigner.target as string,
                data: data,
                gasPrice
            });
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);

            const tx = await contractWithSigner.addROXNFundToRepository(repoId, amountWei, { gasPrice, gasLimit: safeGasLimit });
            
            const receipt = await tx.wait();
            if (!receipt) {
                throw new Error('Failed to add ROXN funds to unified system: Transaction failed');
            }
            log(`ROXN funds added to repo ${repoId} in unified system. TX: ${tx.hash}`, "blockchain");
            return tx;
        } catch (error: any) {
            log(`Error in addROXNFundToRepository: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async addUSDCFundToRepository(repoId: number, usdcAmount: string, userId: number): Promise<ethers.TransactionResponse | null> {
        try {
            if (!this.usdcTokenContract) {
                throw new Error('USDC token not initialized - check USDC_XDC_ADDRESS in .env');
            }

            const user = await storage.getUserById(userId);
            if (!user || !user.xdcWalletAddress || !user.walletReferenceId) {
                throw new Error('User details not found for USDC funding');
            }
            const userWalletPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userWalletPrivateKey.privateKey, this.provider);

            log(`User ${user.username} initiating approval for ${usdcAmount} USDC to main rewards contract ${this.contract.target}`, "blockchain");
            
            // Approve USDC token transfer to main contract
            const amountInSmallestUnit = ethers.parseUnits(usdcAmount, 6); // USDC has 6 decimals
            const usdcTokenWithSigner = this.usdcTokenContract.connect(userWallet) as TokenContract;
            
            const approveTx = await usdcTokenWithSigner.approve(this.contract.target as string, amountInSmallestUnit);
            await approveTx.wait();
            log(`USDC approval confirmed for ${usdcAmount} USDC`, "blockchain");
            
            await new Promise(resolve => setTimeout(resolve, 3000));

            log(`User ${user.username} adding ${usdcAmount} USDC to repository ${repoId} via main contract`, "blockchain");

            const contractWithSigner = this.contract.connect(userWallet) as ExtendedContract;
            
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice ? feeData.gasPrice * BigInt(120) / BigInt(100) : undefined;

            const data = contractWithSigner.interface.encodeFunctionData('addUSDCFundToRepository', [repoId, amountInSmallestUnit]);
            const estimatedGas = await this.provider.estimateGas({
                from: userWallet.address,
                to: contractWithSigner.target as string,
                data: data,
                gasPrice
            });
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);

            const tx = await contractWithSigner.addUSDCFundToRepository(repoId, amountInSmallestUnit, { gasPrice, gasLimit: safeGasLimit });
            
            const receipt = await tx.wait();
            if (!receipt) {
                throw new Error('Failed to add USDC funds: Transaction failed');
            }
            log(`USDC funds added to repo ${repoId}. TX: ${tx.hash}`, "blockchain");
            return tx;
        } catch (error: any) {
            log(`Error in addUSDCFundToRepository: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async getRoxnAllowance(ownerAddress: string, spenderAddress: string): Promise<bigint> {
        try {
            const ethOwnerAddress = ownerAddress.startsWith('xdc') ? ownerAddress.replace('xdc', '0x') : ownerAddress;
            const ethSpenderAddress = spenderAddress.startsWith('xdc') ? spenderAddress.replace('xdc', '0x') : spenderAddress;

            log(`Fetching ROXN allowance for owner: ${ethOwnerAddress}, spender: ${ethSpenderAddress}`, "blockchain");
            
            if (!this.tokenContract) {
                throw new Error("ROXN Token contract not initialized");
            }

            const allowanceWei = await this.tokenContract.allowance(ethOwnerAddress, ethSpenderAddress);
            log(`ROXN allowance is: ${allowanceWei.toString()} wei`, "blockchain");
            return allowanceWei;
        } catch (error: any) {
            log(`Error fetching ROXN allowance: ${error.message}`, "blockchain-ERROR");
            throw error;
        }
    }

    async checkRepositoryInitialization(repoId: number): Promise<{
        isInitialized: boolean;
        hasPoolManagers: boolean;
        xdcBalance: string;
        roxnBalance: string;
        message: string;
    }> {
        try {
            log(`Checking initialization status for repository ${repoId}`, "blockchain");
            
            const repoData = await this.getRepository(repoId);
            
            const hasPoolManagers = repoData.poolManagers && repoData.poolManagers.length > 0;
            const xdcBalance = parseFloat(repoData.xdcPoolRewards || "0");
            const roxnBalance = parseFloat(repoData.roxnPoolRewards || "0");
            
            const isInitialized = hasPoolManagers || xdcBalance > 0 || roxnBalance > 0;
            
            let message = "";
            if (!isInitialized) {
                message = `Repository ${repoId} is not initialized. To initialize:\n` +
                         `1. Add at least one pool manager using addPoolManager()\n` +
                         `2. OR fund the repository with XDC/ROXN which will auto-assign the funder as manager`;
            } else {
                message = `Repository ${repoId} is initialized with ${repoData.poolManagers.length} managers`;
            }
            
            return {
                isInitialized,
                hasPoolManagers,
                xdcBalance: repoData.xdcPoolRewards,
                roxnBalance: repoData.roxnPoolRewards,
                message
            };
        } catch (error: any) {
            log(`Error checking repository initialization: ${error.message}`, "blockchain");
            return {
                isInitialized: false,
                hasPoolManagers: false,
                xdcBalance: "0",
                roxnBalance: "0",
                message: `Failed to check repository: ${error.message}`
            };
        }
    }

    async initializeRepository(
        repoId: number,
        poolManagerAddress: string,
        username: string,
        githubId: number,
        userId: number
    ): Promise<ethers.TransactionReceipt | null> {
        try {
            log(`Initializing repository ${repoId} with pool manager ${username} (${poolManagerAddress})`, "blockchain");
            
            const status = await this.checkRepositoryInitialization(repoId);
            if (status.isInitialized) {
                log(`Repository ${repoId} is already initialized`, "blockchain");
                throw new Error("Repository is already initialized");
            }
            
            return await this.addPoolManager(repoId, poolManagerAddress, username, githubId, userId);
        } catch (error: any) {
            log(`Failed to initialize repository: ${error.message}`, "blockchain");
            throw error;
        }
    }

    async checkNodeRegistration(nodeId: string): Promise<boolean> {
        try {
            log(`Checking registration status for node ${nodeId}`, "blockchain");
            const node = await this.proofOfComputeContract.nodes(nodeId);
            log(`Node ${nodeId} registration status: ${node.isRegistered}`, "blockchain");
            return node.isRegistered;
        } catch (error) {
            console.error('Error checking registration for node:', String(nodeId).substring(0, 100), error);
            return false;
        }
    }

    async registerNode(nodeId: string, walletAddress: string): Promise<ethers.TransactionResponse> {
        try {
            const user = await storage.getUserByWalletAddress(walletAddress);
            if (!user || !user.walletReferenceId) {
                throw new Error(`User not found for wallet address: ${walletAddress}`);
            }
    
            const userPrivateKey = await this.getWalletSecret(user.walletReferenceId);
            const userWallet = new ethers.Wallet(userPrivateKey.privateKey, this.provider);
    
            const contractWithSigner = this.proofOfComputeContract.connect(userWallet) as ProofOfComputeContract;
            const ethWalletAddress = walletAddress.replace('xdc', '0x');
    
            log(`Registering node ${nodeId} with owner ${ethWalletAddress}`, "blockchain");
    
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice ? feeData.gasPrice * BigInt(120) / BigInt(100) : undefined;
    
            const estimateGasFunc = contractWithSigner.getFunction('registerNode');
            const estimatedGas = await estimateGasFunc.estimateGas(nodeId);
            const safeGasLimit = estimatedGas * BigInt(130) / BigInt(100);
            
            const tx = await contractWithSigner.registerNode(nodeId, {
                gasPrice,
                gasLimit: safeGasLimit
            });
            
            log(`Registration transaction sent for node ${nodeId}. TX hash: ${tx.hash}`, "blockchain");
            const receipt = await tx.wait();
    
            if (!receipt) {
                throw new Error('Failed to register node: Transaction failed to confirm');
            }
    
            log(`Registration transaction confirmed for node ${nodeId}.`, "blockchain");
            
            return tx;
        } catch (error) {
            console.error('Failed to register node:', String(nodeId).substring(0, 100), error);
            throw error;
        }
    }

    async getComputeUnits(walletAddress: string): Promise<number> {
        try {
            const ethAddress = walletAddress.replace('xdc', '0x');
            log(`Fetching compute units for address: ${ethAddress}`, "blockchain");
            const units = await this.proofOfComputeContract.computeUnits(ethAddress);
            return Number(units);
        } catch (error) {
            console.error(`Failed to get compute units for ${walletAddress}:`, error);
            // Return 0 instead of throwing, as the frontend expects a number
            return 0;
        }
    }
}

export const blockchain = new BlockchainService();

export interface PoolManager {
    username: string;
    githubId: bigint;
    wallet: string;
}

export interface Contributor {
    username: string;
    githubId: bigint;
    wallet: string;
}

export interface Issue {
    issueId: bigint;
    rewardAmount: bigint;
    status: string;
}

interface Transaction {
    hash: string;
    blockNumber: number;
    from: string;
    to: string;
    value: string;
    timestamp: string;
    confirmations: number;
    isIncoming: boolean;
    status: 'confirmed' | 'pending';
    tokenSymbol?: string;  // 'XDC', 'ROXN', 'USDC', etc.
    tokenAmount?: string;  // Formatted token amount
}
