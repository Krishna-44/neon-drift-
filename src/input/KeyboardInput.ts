/**
 * Keyboard fallback controller (also the accessibility path and the test
 * harness input). Produces the same CarInputs contract as gestures, with
 * analogue-feel ramps so arrow-key driving doesn't snap.
 */
import { clamp, moveToward } from '../core/MathUtils';
import { CarInputs, neutralInputs } from './ControlState';

const STEER_RATE = 7;        // per second toward target
const STEER_RETURN_RATE = 9;
const THROTTLE_RATE = 5;
const BRAKE_RATE = 8;

export class KeyboardInput {
  private keys = new Set<string>();
  private inputs: CarInputs = neutralInputs();
  private lastActivity = -Infinity;
  private attached = false;
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = this.normalize(e.code);
    if (k) {
      this.keys.add(k);
      this.lastActivity = performance.now();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    const k = this.normalize(e.code);
    if (k) {
      this.keys.delete(k);
      this.lastActivity = performance.now();
    }
  };

  attach(): void {
    if (this.attached) return;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.keys.clear();
    this.attached = false;
  }

  private normalize(code: string): string | null {
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        return 'up';
      case 'ArrowDown':
      case 'KeyS':
        return 'down';
      case 'ArrowLeft':
      case 'KeyA':
        return 'left';
      case 'ArrowRight':
      case 'KeyD':
        return 'right';
      case 'Space':
        return 'handbrake';
      case 'ShiftLeft':
      case 'ShiftRight':
        return 'nitro';
      case 'KeyR':
        return 'reverse';
      default:
        return null;
    }
  }

  /** True if the user touched driving keys in the last `windowMs`. */
  isActive(windowMs = 400): boolean {
    return this.keys.size > 0 || performance.now() - this.lastActivity < windowMs;
  }

  update(dt: number): CarInputs {
    const steerTarget = (this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
    const rate = steerTarget === 0 ? STEER_RETURN_RATE : STEER_RATE;
    this.inputs.steer = clamp(moveToward(this.inputs.steer, steerTarget, rate * dt), -1, 1);
    this.inputs.throttle = moveToward(this.inputs.throttle, this.keys.has('up') ? 1 : 0, THROTTLE_RATE * dt);
    this.inputs.brake = moveToward(this.inputs.brake, this.keys.has('down') ? 1 : 0, BRAKE_RATE * dt);
    this.inputs.handbrake = this.keys.has('handbrake');
    this.inputs.nitro = this.keys.has('nitro');
    this.inputs.reverse = this.keys.has('reverse');
    return { ...this.inputs };
  }

  resetState(): void {
    this.keys.clear();
    this.inputs = neutralInputs();
  }
}
