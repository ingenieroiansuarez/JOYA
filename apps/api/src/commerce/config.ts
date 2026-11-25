import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ConfigError, type Environment } from "../config";
import { RulesError, validateRules, type PricingRules } from "./pricing";

export interface CommerceConfig {
  rules: PricingRules;
  /** Only "simulated" exists in hito 500 (no money moves); a real provider needs ian's decision, an account and keys. */
  paymentProvider: "simulated";
  /** HMAC key of the simulated provider's webhooks (same check a real provider's signature gets). */
  paymentWebhookSecret: string;
  /** Accepted clock skew of a signed webhook, seconds. */
  webhookToleranceS: number;
}

// dist/commerce (and src/commerce) → repository root.
const ROOT = resolve(__dirname, "../../../..");
const DEFAULT_RULES = "15_COMMERCE_AND_PAYMENTS/pricing.demo.json";

/**
 * Fails closed (CLAUDE.md): production refuses synthetic pricing rules and the simulated payment
 * provider, so a missing real configuration can never quote or "collect" with demo values.
 */
export function loadCommerceConfig(source: NodeJS.ProcessEnv, env: Environment, root = ROOT): CommerceConfig {
  const file = source.PRICING_RULES_FILE ?? DEFAULT_RULES;
  let rules: PricingRules;
  try {
    rules = validateRules(JSON.parse(readFileSync(isAbsolute(file) ? file : resolve(root, file), "utf8")) as PricingRules);
  } catch (err) {
    if (err instanceof RulesError) throw new ConfigError(err.message);
    throw new ConfigError(`PRICING_RULES_FILE could not be read as JSON (${(err as Error).constructor.name})`);
  }
  if (env === "production" && rules.status !== "APPROVED") throw new ConfigError("production needs APPROVED pricing rules, not synthetic demo rules");
  const provider = source.PAYMENT_PROVIDER ?? (env === "production" ? undefined : "simulated");
  if (!provider) throw new ConfigError("PAYMENT_PROVIDER is required in production");
  if (provider !== "simulated") throw new ConfigError(`PAYMENT_PROVIDER ${provider} is not available (only simulated)`);
  if (env === "production") throw new ConfigError("the simulated payment provider is not allowed in production");
  const secret = source.PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) throw new ConfigError("PAYMENT_WEBHOOK_SECRET must be at least 32 characters (pnpm bootstrap writes it)");
  return { rules, paymentProvider: provider, paymentWebhookSecret: secret, webhookToleranceS: 300 };
}
