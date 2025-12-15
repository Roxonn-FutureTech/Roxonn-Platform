import swaggerJsdoc from 'swagger-jsdoc';
import { version } from '../package.json';

const options: swaggerJsdoc.Options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Roxonn Platform API',
            version,
            description: 'API documentation for the Roxonn Platform',
            license: {
                name: 'MIT',
                url: 'https://opensource.org/licenses/MIT',
            },
            contact: {
                name: 'Roxonn Support',
                url: 'https://roxonn.com',
                email: 'support@roxonn.com',
            },
        },
        servers: [
            {
                url: '/api',
                description: 'API Server',
            },
        ],
        components: {
            schemas: {
                User: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        username: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        githubId: { type: 'string' },
                        avatarUrl: { type: 'string' },
                        isProfileComplete: { type: 'boolean' }
                    }
                },
                ReferralInfo: {
                    type: 'object',
                    properties: {
                        code: { type: 'string' },
                        referralCount: { type: 'integer' },
                        totalEarned: { type: 'number' },
                        referrerUsername: { type: 'string' }
                    }
                },
                ReferralStats: {
                    type: 'object',
                    properties: {
                        totalReferrals: { type: 'integer' },
                        totalUsdcEarned: { type: 'number' },
                        totalRoxnEarned: { type: 'number' },
                        pendingUsdc: { type: 'number' },
                        pendingRoxn: { type: 'number' }
                    }
                },
                Error: {
                    type: 'object',
                    properties: {
                        error: { type: 'string' },
                        details: { type: 'object' }
                    }
                },
                RewardInfo: {
                    type: 'object',
                    properties: {
                        usdc: { type: 'number' },
                        roxn: { type: 'number' },
                        rewards: {
                            type: 'array',
                            items: { type: 'object' }
                        }
                    }
                },
                PayoutRequest: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        userId: { type: 'integer' },
                        amountUsdc: { type: 'number' },
                        amountRoxn: { type: 'number' },
                        status: { type: 'string', enum: ['pending', 'paid', 'rejected'] },
                        createdAt: { type: 'string', format: 'date-time' }
                    }
                },
                Repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        githubRepoId: { type: 'string' },
                        githubRepoFullName: { type: 'string' },
                        isPrivate: { type: 'boolean' },
                        xdcPoolRewards: { type: 'string' },
                        roxnPoolRewards: { type: 'string' },
                        usdcPoolRewards: { type: 'string' }
                    }
                },
                WalletInfo: {
                    type: 'object',
                    properties: {
                        address: { type: 'string' },
                        balance: { type: 'string' },
                        tokenBalance: { type: 'string' }
                    }
                },
                Transaction: {
                    type: 'object',
                    properties: {
                        hash: { type: 'string' },
                        from: { type: 'string' },
                        to: { type: 'string' },
                        value: { type: 'string' },
                        timestamp: { type: 'integer' }
                    }
                },
                Subscription: {
                    type: 'object',
                    properties: {
                        active: { type: 'boolean' },
                        periodEnd: { type: 'string', format: 'date-time' },
                        subscription: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                plan: { type: 'string' },
                                status: { type: 'string' }
                            }
                        }
                    }
                },
                WalletBalance: {
                    type: 'object',
                    properties: {
                        currency: { type: 'string' },
                        network: { type: 'string' },
                        balance: { type: 'string' },
                        usdValue: { type: 'string' },
                        address: { type: 'string' }
                    }
                },
                WalletExportResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        address: { type: 'string' },
                        cipherText: { type: 'string' },
                        iv: { type: 'string' },
                        serverPublicKey: { type: 'string' },
                        networkConfig: { type: 'object' }
                    }
                },
                OnrampTransaction: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        userId: { type: 'integer' },
                        walletAddress: { type: 'string' },
                        merchantRecognitionId: { type: 'string' },
                        status: { type: 'string' },
                        fiatCurrency: { type: 'string' },
                        metadata: { type: 'object' },
                        createdAt: { type: 'string', format: 'date-time' }
                    }
                },
                MerchantCheckoutConfig: {
                    type: 'object',
                    properties: {
                        merchantId: { type: 'string' },
                        merchantRecognitionId: { type: 'string' },
                        walletAddress: { type: 'string' },
                        fiatType: { type: 'integer' },
                        logoUrl: { type: 'string' }
                    }
                },
                CryptoPaymentIntent: {
                    type: 'object',
                    properties: {
                        address: { type: 'string' },
                        amount: { type: 'string' },
                        currency: { type: 'string' },
                        network: { type: 'string' }
                    }
                },
                PaymentVerificationResult: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        message: { type: 'string' },
                        subscription: { $ref: '#/components/schemas/Subscription' },
                        needsConfirmation: { type: 'boolean' },
                        transaction: { $ref: '#/components/schemas/OnrampTransaction' },
                        error: { type: 'string' }
                    }
                },
                BountyAllocation: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        transactionHash: { type: 'string' },
                        blockNumber: { type: 'integer' }
                    }
                },
                RepositoryFundingStatus: {
                    type: 'object',
                    properties: {
                        dailyLimit: { type: 'number' },
                        currentTotal: { type: 'number' },
                        remainingLimit: { type: 'number' },
                        windowStartTime: { type: 'string', format: 'date-time' },
                        windowEndTime: { type: 'string', format: 'date-time' }
                    }
                },
                IssueBountyDetails: {
                    type: 'object',
                    properties: {
                        issueId: { type: 'integer' },
                        bountyAmount: { type: 'string' },
                        currencyType: { type: 'string' },
                        isDistributed: { type: 'boolean' },
                        contributor: { type: 'string' }
                    }
                }
            },
            securitySchemes: {
                cookieAuth: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: 'connect.sid',
                },
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [
            {
                cookieAuth: [],
            },
        ],
    },
    apis: ['./server/routes.ts', './server/routes/*.ts', './server/auth.ts'], // Path to the API docs
};

export const swaggerSpec = swaggerJsdoc(options);
