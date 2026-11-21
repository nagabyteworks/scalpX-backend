/**
 * Financial Math & Precision Primitives.
 * All prices and values in scalpX are internally represented as integer paise.
 * NSE Options tick size is 0.05 rupees (5 paise).
 */

const TICK_PAISE_DEFAULT = 5;

/**
 * Validates whether a value is a strictly positive finite number.
 * Throws on NaN, Infinity, or values <= 0.
 */
function assertValidPositiveNumber(val: number, name = 'value'): void {
  if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val) || val <= 0) {
    throw new Error(`Invalid ${name}: ${val}. Expected a finite positive number > 0`);
  }
}

/**
 * Converts a rupee amount (number or decimal string, e.g. "110.05" or 110.05) to integer paise.
 * Throws on NaN, Infinity, or values <= 0.
 */
export function toPaise(rupees: number | string): number {
  if (typeof rupees === 'string') {
    const trimmed = rupees.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new Error(`Invalid rupee string format: "${rupees}". Expected standard positive decimal string.`);
    }
    const parts = trimmed.split('.');
    const whole = parseInt(parts[0]!, 10);
    const frac = parts[1] ? parts[1].padEnd(2, '0').slice(0, 2) : '00';
    const paise = whole * 100 + parseInt(frac, 10);
    assertValidPositiveNumber(paise, 'paise');
    return paise;
  }

  assertValidPositiveNumber(rupees, 'rupees');
  const paise = Math.round(rupees * 100);
  assertValidPositiveNumber(paise, 'paise');
  return paise;
}

/**
 * Formats integer paise to a decimal rupee string with exactly 2 decimal places.
 * Example: 11005 -> "110.05", 10000 -> "100.00".
 * Throws on NaN, Infinity, or values <= 0.
 */
export function fromPaise(paise: number): string {
  assertValidPositiveNumber(paise, 'paise');
  const integerPaise = Math.round(paise);
  const whole = Math.floor(integerPaise / 100);
  const frac = integerPaise % 100;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Rounds paise down to the nearest multiple of tickPaise (default 5 paise).
 * Throws on NaN, Infinity, or values <= 0.
 */
export function roundDownToTick(paise: number, tickPaise = TICK_PAISE_DEFAULT): number {
  assertValidPositiveNumber(paise, 'paise');
  assertValidPositiveNumber(tickPaise, 'tickPaise');
  return Math.floor(paise / tickPaise) * tickPaise;
}

/**
 * Rounds paise up to the nearest multiple of tickPaise (default 5 paise).
 * Throws on NaN, Infinity, or values <= 0.
 */
export function roundUpToTick(paise: number, tickPaise = TICK_PAISE_DEFAULT): number {
  assertValidPositiveNumber(paise, 'paise');
  assertValidPositiveNumber(tickPaise, 'tickPaise');
  return Math.ceil(paise / tickPaise) * tickPaise;
}

/**
 * Verifies if a paise amount is exactly aligned to the given tick size.
 */
export function isTickAligned(paise: number, tickPaise = TICK_PAISE_DEFAULT): boolean {
  if (!Number.isFinite(paise) || paise <= 0) return false;
  return paise % tickPaise === 0;
}
