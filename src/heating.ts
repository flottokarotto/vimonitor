import type { Device, Temperature } from './model.ts';
import type { Schedule } from './schedules.ts';

export interface HeatingSnapshot {
  temperatures: Temperature[];
  schedules: Schedule[];
  scheduleError: string | null;
}

export interface HeatingReader {
  connected(): boolean;
  read(device: Device): Promise<HeatingSnapshot>;
}

export interface HeatingService extends HeatingReader {
  authorization(): { url: string; state: string; verifier: string };
  exchange(code: string, verifier: string): Promise<void>;
  devices(): Promise<Device[]>;
}

export class HeatingError extends Error {
  status: number;
  retrySeconds: number;
  constructor(message: string, status: number, retrySeconds = 0) {
    super(message);
    this.status = status;
    this.retrySeconds = retrySeconds;
  }
}
