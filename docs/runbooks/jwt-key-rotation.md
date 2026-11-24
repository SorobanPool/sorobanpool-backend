# JWT Signing Key Rotation

## Overview

Access tokens are signed with `JWT_SECRET`. To rotate the signing key without invalidating active sessions, the system supports a current key plus one or more previous keys that remain valid for verification.

## When to Rotate

- Security incident: suspected key compromise
- Scheduled rotation: every 90-180 days as a security best practice
- Staff turnover: when operators with key access leave

## Rotation Procedure

### 1. Generate New Secret

```bash
# Generate a 32-byte base64 secret
openssl rand -base64 32
```

### 2. Add Previous Key

Before changing `JWT_SECRET`, add the current value to `JWT_SECRET_PREVIOUS`:

```bash
# If JWT_SECRET_PREVIOUS is empty
export JWT_SECRET_PREVIOUS="<current_JWT_SECRET>"

# If you already have previous keys (comma-separated)
export JWT_SECRET_PREVIOUS="<current_JWT_SECRET>,<existing_previous_keys>"
```

### 3. Update Current Key

Set the new secret as `JWT_SECRET`:

```bash
export JWT_SECRET="<new_secret_from_step_1>"
```

### 4. Deploy

Deploy or restart the services to pick up the new configuration:

```bash
# API servers
kubectl rollout restart deployment/sorobanpool-api

# Or for single-instance deployments
systemctl restart sorobanpool-api
```

### 5. Verify

Confirm that:
- New logins work (new tokens signed with new key)
- Existing sessions still work (old tokens verified with previous key)
- Token refresh works for both old and new tokens

```bash
# Check logs for TOKEN_INVALID errors
kubectl logs -l app=sorobanpool-api --tail=100 | grep TOKEN_INVALID
```

### 6. Remove Old Key (After Grace Period)

Wait at least 15 minutes (ACCESS_TTL_SECONDS) for all old access tokens to expire, then remove the oldest previous key:

```bash
# If you had one previous key, clear it
export JWT_SECRET_PREVIOUS=""

# If you had multiple, remove the oldest
export JWT_SECRET_PREVIOUS="<keep_only_recent_previous_keys>"
```

Deploy again to apply the change.

## Rollback

If issues arise:

1. Revert `JWT_SECRET` to the previous value
2. Remove it from `JWT_SECRET_PREVIOUS`
3. Deploy

All tokens signed with the rolled-back key will work immediately.

## Key Management

- **Storage**: Store keys in your secrets manager (AWS Secrets Manager, Kubernetes Secrets, etc.)
- **Access**: Restrict key access to ops team and CI/CD pipelines only
- **Rotation History**: Keep an audit log of when keys were rotated and by whom
- **Maximum Previous Keys**: Keep at most 2 previous keys to minimize verification overhead

## Testing

The key rotation logic is tested in `src/auth/token.service.spec.ts`:
- Tokens signed with current key verify successfully
- Tokens signed with previous key verify successfully  
- Tokens signed with removed key fail verification
- New tokens are always signed with current key

Run tests:
```bash
pnpm test src/auth/token.service.spec.ts
```
