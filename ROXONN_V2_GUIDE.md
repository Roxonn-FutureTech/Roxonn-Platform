# 🛠 Roxonn Platform: V2 Rewards & Gasless Guide

## 1. Multi-Currency Ecosystem
The Roxonn Platform has upgraded its reward engine to support a triple-asset model. Contributors can now receive bounties in:
* **XDC:** Native network utility.
* **ROXN:** Platform governance and ecosystem token.
* **USDC:** A dollar-pegged stablecoin for value preservation.

## 2. Gasless Claims (Meta-Transactions)
We have integrated an `ICustomForwarder` to remove the "Gas Barrier" for new developers.
* **How it works:** Users sign a claim request off-chain. The Roxonn Relayer submits the transaction and covers the XDC gas cost.
* **Requirement:** Your wallet must be registered via the `registerUser` function to be compatible with the trusted forwarder.

## 3. Understanding Platform Fees
To ensure long-term sustainability, the contract implements a transparent fee deduction during the distribution phase:
* **Platform Fee:** Taken from the repository pool during funding.
* **Contributor Fee:** A small percentage deducted at the moment of reward distribution.
* **Math:** Fees are calculated in Basis Points (100 bps = 1%).
  * *Example:* A 300 bps fee on a 100 USDC reward results in a 97 USDC net payout to the contributor.

## 4. Technical Reference for Managers
When allocating rewards via `allocateIssueReward`, use the following `CurrencyType` integers:
- `0`: XDC
- `1`: ROXN
- `2`: USDC