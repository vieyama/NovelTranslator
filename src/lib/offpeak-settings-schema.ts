export interface OffPeakBookOption {
  id: string;
  title: string;
}

export interface OffPeakSettingsView {
  enabled: boolean;
  bookId: string;
  maxChars: number;
  maxBatches: number;
  delayMsBetweenBatches: number;
  lastRunAt: string | null;
  lastError: string | null;
  books: OffPeakBookOption[];
}

export interface SaveOffPeakSettingsInput {
  enabled?: unknown;
  bookId?: unknown;
  maxChars?: unknown;
  maxBatches?: unknown;
  delayMsBetweenBatches?: unknown;
}
