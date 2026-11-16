import type { buildInsights } from '../src/insights.ts';

export interface Sensor {
  sensor: string;
  label: string;
  kind: 'flow' | 'water' | 'other';
  value: number;
  timestamp: number;
}

export interface Device {
  id: string;
  name: string;
  sensors: Sensor[];
}

export interface Status {
  demo: boolean;
  connected: boolean;
  device: { name: string } | null;
  devices: Device[];
  activeDevice: string | null;
  sensors: Sensor[];
  pollSeconds: number;
  error: string | null;
}

export interface DiscoveredDevice {
  index: number;
  name: string;
  deviceId: string;
  selected: boolean;
}

export interface Point {
  timestamp: number;
  value: number;
  min: number;
  max: number;
  count: number;
}

export type Insights = ReturnType<typeof buildInsights>;
export type Kind = 'flow' | 'water';
export interface Series extends Sensor { device: string; key: string; display: string; index: number }
