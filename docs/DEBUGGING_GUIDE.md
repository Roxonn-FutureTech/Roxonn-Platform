# Debugging Guide

## Common Issue: "Payment Method Failed" Error

If you're seeing generic error messages like "payment method failed", follow these steps:

## 1. Check Browser Console

Open your browser's Developer Tools (F12) and look at the **Console** tab.

The improved error logging will now show:
```
API POST Error: {
  endpoint: "/api/promotional/bounties",
  status: 400,
  errorData: { error: "Actual error message here" },
  requestBody: { ... }
}
```

## 2. Check Server Logs

Run the development server with:
```bash
npm run dev
```

Watch the terminal output for errors. The global error handler will log:
```
ERROR: Actual error message
Stack: Error stack trace
Request: POST /api/promotional/bounties
Body: {"repoId":123,...}
```

## 3. Common Issues & Solutions

### CSRF Token Issues
**Error:** `invalid csrf token` or `403 Forbidden`
**Solution:**
- Clear browser cookies
- Refresh the page to get a new CSRF token
- Check that the API endpoint has `csrfProtection` middleware

### Authentication Issues
**Error:** `Authentication required` or `401 Unauthorized`
**Solution:**
- Make sure you're logged in (check `/api/auth/user`)
- Check browser cookies for session
- For VSCode extension: check JWT token is valid

### Validation Errors
**Error:** `Validation error` with details
**Solution:**
- Check the `details` field in the error response
- Common issues:
  - Missing required fields (repoId, title, description, etc.)
  - Invalid types (e.g., string instead of number)
  - Empty arrays where data is required (e.g., promotionalChannels)

### Database Errors
**Error:** Database-related messages (foreign key, unique constraint, etc.)
**Solution:**
- Check that referenced records exist (e.g., repository exists)
- Check for duplicate entries
- Verify database migrations are up to date: `npm run db:push`

### Blockchain/Wallet Errors
**Error:** Messages about contracts, gas, RPC, etc.
**Solution:**
- Check `server/.env` has correct contract addresses
- Verify XDC_RPC_URL is accessible
- Check wallet has enough gas
- Look at blockchain transaction hash if provided

## 4. Testing API Endpoints Directly

Use curl or Postman to test endpoints directly:

```bash
# Get CSRF token first
curl -c cookies.txt http://localhost:5000/api/auth/user

# Make authenticated request
curl -b cookies.txt -X POST http://localhost:5000/api/promotional/bounties \
  -H "Content-Type: application/json" \
  -d '{
    "repoId": 1,
    "type": "PROMOTIONAL",
    "title": "Test Bounty",
    "description": "Test description",
    "promotionalChannels": ["Twitter"],
    "requiredDeliverable": "Link to tweet",
    "rewardAmount": "100",
    "rewardType": "PER_SUBMISSION"
  }'
```

## 5. Enable Detailed Logging

The server already logs:
- All API requests (method, path, status, duration, response)
- CORS headers
- Session/cookie debugging
- JWT token debugging (for VSCode endpoints)

To see more detailed logs, check the console output when running `npm run dev`.

## 6. Check Network Tab

In Browser DevTools → **Network** tab:
1. Filter by `Fetch/XHR`
2. Click on the failed request
3. Check **Headers** tab for request/response headers
4. Check **Payload** tab for request body
5. Check **Response** tab for server response

## 7. Common Error Messages Explained

| Error Message | Meaning | Solution |
|--------------|---------|----------|
| `Repository not found` | repoId doesn't exist in DB | Use valid repo ID from `/api/promotional/repositories` |
| `Not authorized to create bounties for this repository` | User doesn't own the repo | Login as repo owner |
| `Promotional channels are required` | Empty array | Select at least one channel |
| `Required deliverable is required` | Missing field | Add deliverable description |
| `Validation error` | Schema validation failed | Check Zod error details |
| `Rate limit exceeded` | Too many requests | Wait 15-60 minutes |
| `Invalid CSRF token` | Token expired/missing | Refresh page |

## 8. Database Inspection

Check database records directly:

```bash
# Connect to database (use DATABASE_URL from server/.env)
psql $DATABASE_URL

# Check repositories
SELECT id, user_id, name, github_repo_name FROM registered_repositories;

# Check bounties
SELECT id, repo_id, creator_id, title, status FROM promotional_bounties;

# Check users
SELECT id, github_id, github_username, role FROM users;
```

## 9. Logging Best Practices

When adding new features:

### Client-side:
```typescript
try {
  const result = await api.post('/api/your-endpoint', data);
  console.log('Success:', result);
} catch (error) {
  console.error('Error details:', error);
  // Error is now properly logged by api.ts
}
```

### Server-side:
```typescript
router.post('/your-endpoint', async (req, res) => {
  try {
    // Your logic
    res.json({ success: true });
  } catch (error: any) {
    log(`Error in your-endpoint: ${error.message}`, 'error');
    res.status(500).json({ error: error.message });
  }
});
```

## 10. Production Debugging

In production, errors won't show stack traces. Use:

```bash
# Check PM2 logs
pm2 logs

# Check specific app logs
pm2 logs roxonn-platform

# Real-time log monitoring
pm2 logs --raw | grep ERROR
```

## Need Help?

If you're still stuck after following these steps:
1. Capture the FULL error output (browser console + server logs)
2. Note what action you were performing
3. Include relevant request/response data
4. Check GitHub issues: https://github.com/Roxonn-FutureTech/Roxonn-Platform/issues
