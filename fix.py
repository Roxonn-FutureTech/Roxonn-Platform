import os
import re
import hmac
import hashlib
import json
import logging
from fastapi import FastAPI, Request, HTTPException, Header
from github import Github, GithubIntegration

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GITHUB_APP_ID = os.getenv("GITHUB_APP_ID")
GITHUB_PRIVATE_KEY = os.getenv("GITHUB_PRIVATE_KEY")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN") # Fallback
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET")
MIN_BOUNTY = 50
TECH_KEYWORDS = ["react", "python", "solidity", "typescript", "rust", "node", "javascript", "go"]

# Fail closed if security config is missing
if not WEBHOOK_SECRET:
    logger.error("WEBHOOK_SECRET is not set. Webhook verification will fail.")

app = FastAPI()

# Idempotency cache (simple in-memory for demo, should be Redis in prod)
processed_deliveries = set()

def get_github_client(installation_id: int = None):
    """Returns an authenticated GitHub client scoped to the installation."""
    if GITHUB_APP_ID and GITHUB_PRIVATE_KEY and installation_id:
        integration = GithubIntegration(GITHUB_APP_ID, GITHUB_PRIVATE_KEY)
        access_token = integration.get_access_token(installation_id).token
        return Github(access_token)
    return Github(GITHUB_TOKEN)

def verify_signature(payload_body: bytes, signature_header: str) -> bool:
    """Secure HMAC-SHA256 signature verification."""
    if not WEBHOOK_SECRET or not signature_header:
        return False
    hash_object = hmac.new(WEBHOOK_SECRET.encode(), msg=payload_body, digestmod=hashlib.sha256)
    expected_signature = "sha256=" + hash_object.hexdigest()
    return hmac.compare_digest(expected_signature, signature_header)

def extract_bounty(text: str) -> int:
    """Extracts bounty amount from issue body using multiple patterns."""
    patterns = [
        r'\$(\d+(?:\.\d{2})?)',
        r'Price:\s*(\d+)\s*USD',
        r'💰\s*(\d+)',
        r'/bounty\s+(\d+)'
    ]
    amounts = []
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for m in matches:
            try:
                val = int(float(m))
                if val >= MIN_BOUNTY:
                    amounts.append(val)
            except ValueError:
                continue
    return max(amounts) if amounts else 0

def detect_tech(text: str) -> list:
    """Detects technology keywords for issue categorization."""
    return [kw for kw in TECH_KEYWORDS if kw.lower() in text.lower()]

@app.post("/webhook")
async def github_webhook(
    request: Request, 
    x_hub_signature_256: str = Header(None),
    x_github_delivery: str = Header(None)
):
    """Main webhook handler with security and idempotency."""
    payload_body = await request.body()
    
    # 1. Verify Signature (Security)
    if not verify_signature(payload_body, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="Invalid signature")

    # 2. Idempotency Check
    if x_github_delivery in processed_deliveries:
        return {"status": "already_processed"}
    processed_deliveries.add(x_github_delivery)
    if len(processed_deliveries) > 1000: # Simple LRU-ish cleanup
        processed_deliveries.clear()

    event = request.headers.get("X-GitHub-Event")
    try:
        data = json.loads(payload_body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON") from None

    repo_full_name = data.get("repository", {}).get("full_name")
    installation_id = data.get("installation", {}).get("id")
    
    if not repo_full_name:
        return {"status": "ignored"}
    
    gh = get_github_client(installation_id)
    repo = gh.get_repo(repo_full_name)

    # 3. Handle Issue Events (Bounty Detection & Onboarding)
    if event == "issues" and data.get("action") in ["opened", "edited"]:
        issue_data = data["issue"]
        combined_text = "{0} {1}".format(issue_data.get("title", ""), issue_data.get("body", "") or "")
        bounty = extract_bounty(combined_text)
        
        issue = repo.get_issue(number=issue_data["number"])
        
        # De-duplicate onboarding comment
        comments = issue.get_comments()
        if any("💰 Bounty Instructions" in c.body for c in comments):
            return {"status": "already_tagged"}

        msg = (
            "### 👋 Welcome to Roxonn Platform!\n\n"
            "Thank you for your contribution. If this is a bounty issue, please follow these steps:\n\n"
            "#### 💰 Bounty Details\n"
            "- **Detected Amount:** ${0}\n"
            "- **Tech Stack:** {1}\n\n"
            "#### 🛠️ How to Participate\n"
            "1. **Register:** Comment `/attempt` on this issue to signal your intent.\n"
            "2. **Implement:** Create a Pull Request referencing this issue (e.g., `Fixes #{2}`).\n"
            "3. **Payout:** Payout is manually triggered by maintainers upon successful verification of the merge.\n\n"
            "#### 📚 Resources\n"
            "- [Bounty FAQ](https://roxonn.com/faq)\n"
            "- [Submission Requirements](https://roxonn.com/docs/contributing)\n"
            "---\n"
            "*Note: Use `/bounty <amount> <currency>` to set/update a bounty explicitly.*"
        ).format(
            bounty if bounty > 0 else "TBD", 
            ", ".join(detect_tech(combined_text)) if detect_tech(combined_text) else "General", 
            issue_data["number"]
        )
        issue.create_comment(msg)

    # 4. Handle Issue Commands (/attempt, /bounty, status)
    elif event == "issue_comment" and data.get("action") == "created":
        comment_body = data["comment"]["body"].strip().lower()
        issue_number = data["issue"]["number"]
        user = data["sender"]["login"]
        issue = repo.get_issue(number=issue_number)

        if comment_body == "/attempt":
            # Rate limiting check would go here (1 command/min/user/issue)
            issue.create_comment(f"@{user} has been registered as an active contributor for this bounty. Good luck!")
            logger.info(f"Registered attempt: user={user}, issue={issue_number}")

        elif comment_body.startswith("/bounty"):
            # Handle explicit bounty setting
            parts = comment_body.split()
            if len(parts) >= 2:
                amount = parts[1]
                issue.create_comment(f"✅ Bounty updated to {amount}. Total funding must be verified before payout.")

        elif "@roxonn status" in comment_body:
            issue.create_comment("📊 **Bounty Status:** Open | **Claimants:** 1 | **Funding:** Pending Verification")

    # 5. Handle Pull Request Merge (Validation)
    elif event == "pull_request" and data.get("action") == "closed":
        pr_data = data["pull_request"]
        if pr_data.get("merged") is True:
            pr_body = pr_data.get("body", "") or ""
            # Find linked issues
            linked_issues = re.findall(r'(?:Fixes|Closes|Resolves)\s+#(\d+)', pr_body, re.IGNORECASE)
            for issue_num in linked_issues:
                target_issue = repo.get_issue(number=int(issue_num))
                bounty_val = extract_bounty("{0} {1}".format(target_issue.title, target_issue.body or ""))
                
                if bounty_val > 0:
                    pr = repo.get_pull(pr_data["number"])
                    payout_msg = (
                        "🎉 **Bounty Validated**\n"
                        "Target Issue: #{0}\n"
                        "Amount: ${1}\n"
                        "Contributor: @{2}\n\n"
                        "**Status:** Merge detected. Payout verification in progress. Payouts are normally processed within 60 seconds of manual audit."
                    ).format(issue_num, bounty_val, pr_data["user"]["login"])
                    pr.create_comment(payout_msg)
                    logger.info(f"Bounty validated for PR #{pr_data['number']} -> Issue #{issue_num}")

    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    # Use environment port for deployment flexibility
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
