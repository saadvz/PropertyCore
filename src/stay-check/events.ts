/**
 * One night's events in a shape no camera provider owns (#239). The camera connection and the noise sensor fill
 * it later; for now the check runs on sample events. Media is kept by reference and never copied.
 */

export interface MediaRef {
  /** The camera's name. */
  device: string;
  /** When, in milliseconds since the epoch. */
  at: number;
  durationMs?: number;
}

export interface StayEvent {
  id: string;
  /** ISO time. */
  at: string;
  source: "camera" | "noise";
  /** The camera or sensor's name. */
  device: string;
  /** The provider's label as given, like "human" or "vehicle". The check never reads it. */
  label?: string;
  /** Our own count from the snapshot. */
  counts?: { people?: number; vehicles?: number; animals?: number };
  noiseDb?: number;
  /** The sensor's own noise alert. */
  loud?: boolean;
  snapshot?: MediaRef;
  clip?: MediaRef;
}
