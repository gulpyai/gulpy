import type { Config } from "../config.ts";
import { googleProvider } from "./google.ts";
import { microsoftProvider } from "./microsoft.ts";
import type { Provider } from "./types.ts";

export type Providers = ReadonlyMap<string, Provider>;

/**
 * A provider is available only if its OAuth client credentials are set.
 * `extra` adds providers that are not built in. The tests use it.
 */
export function loadProviders(config: Config, extra: readonly Provider[] = []): Providers {
  const providers = new Map<string, Provider>();
  if (config.google) providers.set("google", googleProvider(config.google));
  if (config.microsoft) providers.set("microsoft", microsoftProvider(config.microsoft));
  for (const provider of extra) providers.set(provider.id, provider);
  return providers;
}
