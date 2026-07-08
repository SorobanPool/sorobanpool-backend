/** USDC on Stellar has 7 decimals; all on-chain amounts are integers in stroops. */
export const USDC_DECIMALS = 7;
export const STROOPS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

export function toStroops(usdc: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(usdc);
  if (!m) throw new Error(`invalid USDC amount: ${usdc}`);
  return BigInt(m[1]!) * STROOPS_PER_USDC + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}

export function formatUsdc(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = (abs % STROOPS_PER_USDC).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error('division by zero');
  return (a * b) / c;
}

export const BPS = 10_000n;
export const bpOf = (amount: bigint, bp: number | bigint): bigint => mulDivFloor(amount, BigInt(bp), BPS);
