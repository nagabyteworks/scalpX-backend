import { describe, it, expect } from 'vitest';
import {
  toPaise,
  fromPaise,
  roundDownToTick,
  roundUpToTick,
  isTickAligned,
} from '../src/domain/models/Money.js';

describe('Money Primitives', () => {
  describe('toPaise', () => {
    it('converts decimal rupee strings to integer paise accurately', () => {
      expect(toPaise('110.05')).toBe(11005);
      expect(toPaise('100.00')).toBe(10000);
      expect(toPaise('100')).toBe(10000);
      expect(toPaise('0.05')).toBe(5);
      expect(toPaise('1234.50')).toBe(123450);
      expect(toPaise('1234.5')).toBe(123450);
    });

    it('converts numbers to integer paise avoiding float precision errors', () => {
      expect(toPaise(110.05)).toBe(11005);
      expect(toPaise(100.0)).toBe(10000);
      expect(toPaise(0.05)).toBe(5);
    });

    it('throws on invalid formats or non-positive values', () => {
      expect(() => toPaise(0)).toThrow();
      expect(() => toPaise(-10)).toThrow();
      expect(() => toPaise('0')).toThrow();
      expect(() => toPaise('-5.00')).toThrow();
      expect(() => toPaise(NaN)).toThrow();
      expect(() => toPaise(Infinity)).toThrow();
      expect(() => toPaise('abc')).toThrow();
      expect(() => toPaise('10.005')).toThrow(); // More than 2 decimal digits
    });
  });

  describe('fromPaise', () => {
    it('formats integer paise to 2-decimal rupee string', () => {
      expect(fromPaise(11005)).toBe('110.05');
      expect(fromPaise(10000)).toBe('100.00');
      expect(fromPaise(5)).toBe('0.05');
      expect(fromPaise(50)).toBe('0.50');
      expect(fromPaise(123450)).toBe('1234.50');
    });

    it('throws on non-positive or non-finite values', () => {
      expect(() => fromPaise(0)).toThrow();
      expect(() => fromPaise(-500)).toThrow();
      expect(() => fromPaise(NaN)).toThrow();
      expect(() => fromPaise(Infinity)).toThrow();
    });
  });

  describe('roundDownToTick & roundUpToTick', () => {
    it('rounds down to 5 paise tick', () => {
      expect(roundDownToTick(11004, 5)).toBe(11000);
      expect(roundDownToTick(11005, 5)).toBe(11005);
      expect(roundDownToTick(11009, 5)).toBe(11005);
      expect(roundDownToTick(11000, 5)).toBe(11000);
    });

    it('rounds up to 5 paise tick', () => {
      expect(roundUpToTick(11001, 5)).toBe(11005);
      expect(roundUpToTick(11005, 5)).toBe(11005);
      expect(roundUpToTick(11006, 5)).toBe(11010);
      expect(roundUpToTick(11000, 5)).toBe(11000);
    });

    it('throws on invalid paise or tick sizes', () => {
      expect(() => roundDownToTick(0)).toThrow();
      expect(() => roundDownToTick(-100)).toThrow();
      expect(() => roundDownToTick(100, 0)).toThrow();
      expect(() => roundUpToTick(0)).toThrow();
      expect(() => roundUpToTick(100, -5)).toThrow();
    });
  });

  describe('isTickAligned', () => {
    it('returns true only for valid tick multiples', () => {
      expect(isTickAligned(11005)).toBe(true);
      expect(isTickAligned(11000)).toBe(true);
      expect(isTickAligned(11004)).toBe(false);
      expect(isTickAligned(11001)).toBe(false);
    });
  });
});
