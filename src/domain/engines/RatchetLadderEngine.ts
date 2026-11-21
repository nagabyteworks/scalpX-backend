import { randomUUID } from 'node:crypto';
import type { LadderPosition, LadderConfigUpdate } from '../models/LadderPosition.js';
import type { Tick } from '../models/Tick.js';
import type { BrokerPort } from '../ports/BrokerPort.js';
import type { StateStorePort } from '../ports/StateStorePort.js';
import { roundDownToTick } from '../models/Money.js';

export interface RatchetAlertEvent {
  token: string;
  symbol: string;
  type: 'MANUAL_INTERVENTION' | 'POSITION_CLOSED' | 'SL_MODIFIED' | 'SL_PLACED';
  message: string;
  error?: unknown;
  timestamp: number;
}

export type AlertCallback = (event: RatchetAlertEvent) => void;

/**
 * RatchetLadderEngine
 *
 * Implements the core local-limit-to-SL mechanism:
 * - Upside target levels stay strictly local in memory (NEVER placed as exchange Limit orders).
 * - Ratchets exchange SL-LMT upward in O(1) step jumps when breakout buffer is crossed.
 * - Non-blocking in-flight mutex lock ensures rapid market ticks never fire duplicate calls.
 * - Async state persistence ensures zero-DB latency on hot tick path.
 */
export class RatchetLadderEngine {
  // Zero-DB hot path: active positions strictly in memory
  private readonly positions = new Map<string, LadderPosition>();
  private readonly broker: BrokerPort;
  private readonly stateStore?: StateStorePort;
  private readonly alertListeners: AlertCallback[] = [];

  constructor(broker: BrokerPort, stateStore?: StateStorePort) {
    this.broker = broker;
    this.stateStore = stateStore;
  }

  registerPosition(position: LadderPosition): void {
    this.positions.set(position.token, position);
    if (this.stateStore) {
      this.stateStore.savePosition(position).catch(() => {});
    }
  }

  getPosition(token: string): LadderPosition | undefined {
    return this.positions.get(token);
  }

  getAllPositions(): LadderPosition[] {
    return Array.from(this.positions.values());
  }

  removePosition(token: string): void {
    this.positions.delete(token);
  }

  onAlert(callback: AlertCallback): void {
    this.alertListeners.push(callback);
  }

  private emitAlert(event: Omit<RatchetAlertEvent, 'timestamp'>): void {
    const fullEvent: RatchetAlertEvent = { ...event, timestamp: Date.now() };
    for (const listener of this.alertListeners) {
      try {
        listener(fullEvent);
      } catch {
        // Safe dispatch: alert handlers must never disrupt engine flow
      }
    }
  }

  /**
   * Live overrides: updates ladder milestones and buffers mid-trade without cancelling existing SL.
   */
  updateLadderConfig(token: string, config: LadderConfigUpdate): void {
    const pos = this.positions.get(token);
    if (!pos) {
      throw new Error(`Cannot update config: Position with token ${token} not found`);
    }

    if (config.nextMilestonePaise !== undefined) {
      pos.nextMilestonePaise = config.nextMilestonePaise;
    }
    if (config.stepSizePaise !== undefined) {
      pos.stepSizePaise = config.stepSizePaise;
    }
    if (config.breakoutBufferPaise !== undefined) {
      pos.breakoutBufferPaise = config.breakoutBufferPaise;
    }
    if (config.slippageBufferPaise !== undefined) {
      pos.slippageBufferPaise = config.slippageBufferPaise;
    }
    if (config.paused !== undefined) {
      pos.isPaused = config.paused;
    }
    pos.updatedAt = Date.now();

    if (this.stateStore) {
      this.stateStore.savePosition(pos).catch(() => {});
    }
  }

  /**
   * Main tick processing hot path.
   * Runs synchronously in memory until broker invocation; non-blocking lock guards concurrency.
   */
  async onTick(tick: Tick): Promise<void> {
    const pos = this.positions.get(tick.token);
    if (!pos || pos.status !== 'OPEN' || pos.isPaused) {
      return;
    }

    // 1. Guard: Non-blocking in-flight mutex lock
    if (pos.isUpdating) {
      return;
    }

    // 2. Check breakout threshold: While ltp < nextMilestone + breakoutBuffer, do nothing
    const triggerThreshold = pos.nextMilestonePaise + pos.breakoutBufferPaise;
    if (tick.ltpPaise < triggerThreshold) {
      return;
    }

    // 3. O(1) steps calculation for gap-up spikes (e.g. 109 -> 122 jumps to 120 in one broker call)
    const stepsCrossed = Math.floor(
      (tick.ltpPaise - pos.breakoutBufferPaise - pos.nextMilestonePaise) / pos.stepSizePaise
    );
    const newSlTrigger = roundDownToTick(pos.nextMilestonePaise + stepsCrossed * pos.stepSizePaise);
    const newSlLimit = roundDownToTick(newSlTrigger - pos.slippageBufferPaise);

    // 4. Guard: if activeSlTrigger !== null && newSlTrigger <= activeSlTrigger, return immediately
    if (pos.activeSlTriggerPaise !== null && newSlTrigger <= pos.activeSlTriggerPaise) {
      return;
    }

    // 5. Acquire lock before broker call
    pos.isUpdating = true;

    try {
      if (pos.activeSlOrderId === null) {
        // Initial SL-LMT placement
        const result = await this.broker.placeSlLimitOrder({
          commandId: randomUUID(),
          token: pos.token,
          symbol: pos.symbol,
          exchange: 'NFO',
          side: 'SELL',
          orderType: 'SL-LMT',
          quantity: pos.quantity,
          pricePaise: newSlLimit,
          triggerPricePaise: newSlTrigger,
          priority: 'NORMAL',
        });
        pos.activeSlOrderId = result.orderId;
        this.emitAlert({
          token: pos.token,
          symbol: pos.symbol,
          type: 'SL_PLACED',
          message: `Placed SL-LMT at Trigger ${newSlTrigger} / Limit ${newSlLimit}`,
        });
      } else {
        // SL-LMT ratchet modification
        await this.broker.modifySlLimitOrder({
          commandId: randomUUID(),
          orderId: pos.activeSlOrderId,
          token: pos.token,
          symbol: pos.symbol,
          orderType: 'SL-LMT',
          newQuantity: pos.quantity,
          newPricePaise: newSlLimit,
          newTriggerPricePaise: newSlTrigger,
          priority: 'NORMAL',
        });
        this.emitAlert({
          token: pos.token,
          symbol: pos.symbol,
          type: 'SL_MODIFIED',
          message: `Modified SL-LMT to Trigger ${newSlTrigger} / Limit ${newSlLimit}`,
        });
      }

      // 6. Update active SL trigger and next milestone ONLY after the broker call resolves
      pos.activeSlTriggerPaise = newSlTrigger;
      pos.activeSlLimitPaise = newSlLimit;
      pos.nextMilestonePaise = newSlTrigger + pos.stepSizePaise;
      pos.updatedAt = Date.now();

      // Async persistence to state store (zero-DB hot path)
      if (this.stateStore) {
        this.stateStore.savePosition(pos).catch(() => {});
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isCompletedOrNotFound =
        errMsg.toLowerCase().includes('already completed') ||
        errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('filled');

      if (isCompletedOrNotFound) {
        // Order completed or not found: mark position CLOSED and remove from active map
        pos.status = 'CLOSED';
        this.positions.delete(pos.token);
        if (this.stateStore) {
          this.stateStore.updatePositionStatus(pos.token, 'CLOSED').catch(() => {});
        }
        this.emitAlert({
          token: pos.token,
          symbol: pos.symbol,
          type: 'POSITION_CLOSED',
          message: `Position marked CLOSED. Broker status: ${errMsg}`,
        });
      } else {
        // Broker error: pause ratcheting, mark MANUAL_INTERVENTION, emit structured alert
        pos.status = 'MANUAL_INTERVENTION';
        pos.isPaused = true;
        if (this.stateStore) {
          this.stateStore.updatePositionStatus(pos.token, 'MANUAL_INTERVENTION').catch(() => {});
        }
        this.emitAlert({
          token: pos.token,
          symbol: pos.symbol,
          type: 'MANUAL_INTERVENTION',
          message: `Broker call failed: ${errMsg}`,
          error: err,
        });
      }
    } finally {
      // 7. Release in-flight lock
      pos.isUpdating = false;
    }
  }
}
