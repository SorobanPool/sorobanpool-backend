/**
 * Resolves a `*_REF` value to a secret. Only `env:NAME` is implemented (reads process.env[NAME]); a real
 * secret-manager adapter (AWS/GCP/Vault) must be added before production. `literal:` is dev only.
 */
export function resolveSecret(ref: string, nodeEnv: string, source: NodeJS.ProcessEnv = process.env): string {
  if (ref.startsWith('env:')) {
    const v = source[ref.slice(4)];
    if (!v) throw new Error(`secret ${ref} is not set`);
    return v;
  }
  if (ref.startsWith('literal:')) {
    if (nodeEnv === 'production') throw new Error('literal secrets are not allowed in production');
    return ref.slice(8);
  }
  throw new Error(`no secret-manager adapter is configured for reference "${ref}"; use env:NAME in development`);
}
