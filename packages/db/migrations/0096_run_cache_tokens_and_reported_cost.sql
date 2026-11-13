-- Cache read and cache creation tokens stay in their own columns (they are priced differently from fresh input), a Run keeps the cost its CLI reported, and a model price may carry a cached-input price.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cache_read_tokens integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cache_creation_tokens integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN IF NOT EXISTS reported_cost_usd numeric(12, 6);
--> statement-breakpoint
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS cached_input_usd_per_million numeric(12, 4);
