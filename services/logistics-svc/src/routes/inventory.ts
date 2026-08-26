// SVC-017/018 REST surface — 07-data-api.md §13.1: GET /api/v1/logistics/inventory.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { inventoryItems, inventoryForecasts } from "@vektor/db";
import { InventoryItem, InventoryForecast } from "@vektor/shared";

const InventoryWithForecast = z.object({
  item: InventoryItem,
  forecast: InventoryForecast.nullable(),
});

const inventoryRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/logistics/inventory",
    { preHandler: app.requireRole("logistics+"), schema: { response: { 200: z.array(InventoryWithForecast) } } },
    async () => {
      const items = await app.db.select().from(inventoryItems);
      const results = [];
      for (const item of items) {
        const [forecastRow] = await app.db.select().from(inventoryForecasts).where(eq(inventoryForecasts.item_id, item.item_id)).limit(1);
        results.push({
          item: InventoryItem.parse({ ...item, updated_at: item.updated_at.toISOString() }),
          forecast: forecastRow
            ? InventoryForecast.parse({ ...forecastRow, forecast_at: (forecastRow.forecast_at ?? new Date()).toISOString() })
            : null,
        });
      }
      return results;
    },
  );
};

export default inventoryRoutes;
