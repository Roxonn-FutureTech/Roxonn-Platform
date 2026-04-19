import glob
import re

files = glob.glob('server/routes/*.ts')

def generate_openapi_doc(method, path):
    # Convert path params like :id to {id}
    openapi_path = re.sub(r':([a-zA-Z0-9_]+)', r'{\1}', path)
    
    # Determine basic tag
    tag = "General"
    if "admin" in path: tag = "Admin"
    elif "community" in path: tag = "Community Bounties"
    elif "ai" in path or "vscode" in path: tag = "AI Integration"
    elif "blockchain" in path: tag = "Blockchain"
    elif "misc" in path: tag = "Misc"
    elif "leaderboard" in path: tag = "Leaderboard"
    elif "promotional" in path: tag = "Promotional Bounties"
    elif "repository" in path: tag = "Repository"
    elif "referral" in path: tag = "Referrals"
    
    # Extract path parameters for JSDoc
    params = re.findall(r'{([a-zA-Z0-9_]+)}', openapi_path)
    
    doc = [
        "/**",
        " * @openapi",
        f" * {openapi_path}:",
        f" *   {method}:",
        f" *     summary: Endpoint for {method.upper()} {openapi_path}",
        f" *     tags: [{tag}]",
        " *     security:",
        " *       - cookieAuth: []",
        " *       - bearerAuth: []"
    ]
    
    if params:
        doc.append(" *     parameters:")
        for p in params:
            doc.append(f" *       - in: path")
            doc.append(f" *         name: {p}")
            doc.append(f" *         required: true")
            doc.append(f" *         schema: {{ type: string }}")
            
    # Add generic request body for POST/PUT if no params are known for sure
    # It's better to leave it empty or very generic so swagger doesn't break
    
    doc.extend([
        " *     responses:",
        " *       200:",
        " *         description: Successful response",
        " *         content:",
        " *           application/json:",
        " *             schema: { type: object }",
        " *       400:",
        " *         description: Bad request",
        " *       401:",
        " *         description: Unauthorized",
        " *       500:",
        " *         description: Internal server error",
        " */"
    ])
    
    return "\n".join(doc) + "\n"

for filepath in files:
    with open(filepath, 'r', encoding='utf-8') as f:
        try:
            lines = f.readlines()
        except:
            continue
            
    new_lines = []
    i = 0
    while i < len(lines):
        line = lines[i]
        match = re.search(r'router\.(get|post|put|patch|delete)\s*\(\s*[\'"`]([^\'"`]+)[\'"`]', line)
        if match:
            method = match.group(1)
            path = match.group(2)
            
            # check backwards for @openapi
            has_doc = False
            for j in range(len(new_lines)-1, max(-1, len(new_lines)-70), -1):
                if '@openapi' in new_lines[j]:
                    has_doc = True
                    break
                if 'export default router' in new_lines[j] or ('router.' in new_lines[j] and 'router.use' not in new_lines[j]):
                    break
                    
            if not has_doc:
                # Insert the doc
                doc_str = generate_openapi_doc(method, path)
                new_lines.append(doc_str)
                print(f"Patched: {method.upper()} {path} in {filepath}")
                
        new_lines.append(line)
        i += 1
        
    with open(filepath, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

print("Batch patching complete!")
