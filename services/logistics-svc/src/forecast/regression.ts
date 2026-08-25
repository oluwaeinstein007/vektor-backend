// SVC-018 — REQ-6.1: "Real-time asset inventory with depletion-rate
// forecasting ... recomputed every 15 min." REQ-6.3: "Predictive low-stock
// alerts before depletion ... configurable lead-time threshold."
//
// `ml-regression-simple-linear` (the single-predictor regressor
// `ml-regression`'s meta-package re-exports) fits quantity-over-time
// linearly per item — a real, testable regression, not a hand-rolled
// slope average, though it's still just linear (no seasonality/trend
// decomposition) — same "genuine but scoped" tradeoff as alert-svc's EWMA
// anomaly detector.
import { SimpleLinearRegression } from "ml-regression-simple-linear";

export interface HistoryPoint {
  ts: Date;
  quantity: number;
}

export interface ForecastResult {
  depletion_rate_per_hour: number; // positive = declining stock, negative = replenishing
  hours_to_stockout: number | null;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Needs at least 2 distinct-in-time points to fit a line — returns a
 * zero-rate, no-projection result otherwise rather than throwing, since a
 * brand-new item (one CDC snapshot, no history yet) is an expected steady
 * state, not an error.
 */
export function forecastDepletion(history: HistoryPoint[]): ForecastResult {
  if (history.length < 2) {
    return { depletion_rate_per_hour: 0, hours_to_stockout: null };
  }

  const sorted = [...history].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const t0 = sorted[0]!.ts.getTime();
  const xHours = sorted.map((p) => (p.ts.getTime() - t0) / MS_PER_HOUR);
  const y = sorted.map((p) => p.quantity);

  // All samples at the same instant (t0 repeated) — regression is
  // undefined (zero-width x range), same "no real trend yet" case as < 2
  // points.
  if (xHours[xHours.length - 1] === 0) {
    return { depletion_rate_per_hour: 0, hours_to_stockout: null };
  }

  const model = new SimpleLinearRegression(xHours, y);
  const slopePerHour = model.slope; // d(quantity)/d(hour)
  const depletionRatePerHour = -slopePerHour;

  const latestQuantity = y[y.length - 1]!;
  const hoursToStockout = depletionRatePerHour > 0 ? latestQuantity / depletionRatePerHour : null;

  return { depletion_rate_per_hour: depletionRatePerHour, hours_to_stockout: hoursToStockout };
}

export function isLowStock(quantity: number, reorderThreshold: number, hoursToStockout: number | null, leadTimeHours: number): boolean {
  if (quantity <= reorderThreshold) return true;
  return hoursToStockout !== null && hoursToStockout <= leadTimeHours;
}
