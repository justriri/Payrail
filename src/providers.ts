// Provider adapters: the seam that lets Payrail grow beyond one marketplace and one conversion venue.
//
//  - A ServiceProvider lists paid services and reports what a service ACTUALLY asks for (never trusting
//    catalog prices). Buy's gateway is the first.
//  - A ConversionProvider prices currency conversions (RouteProvider). Textile FX is the first.
//
// The planner talks to these interfaces, so a second marketplace or a second FX venue is a new adapter, not
// a change to planning, policy, authorization or receipts. Providers are untrusted: policy decides what is
// contactable and payable, never the provider.
import { createCatalogClient } from './catalog.ts';
import type { Catalog, Service } from './catalog.ts';
import type { SpendingPolicy } from './policy.ts';
import { discoverRequirements } from './requirements.ts';
import type { DiscoveryResult } from './requirements.ts';
import type { RouteProvider } from './routes.ts';

export interface ServiceProvider {
  readonly id: string;
  catalog(opts?: { forceRefresh?: boolean }): Promise<Catalog>;
  discover(service: Service, body: string): Promise<DiscoveryResult>;
}

export type ConversionProvider = RouteProvider;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface FoundService {
  provider: ServiceProvider;
  service: Service;
}

export function createRegistry() {
  const services = new Map<string, ServiceProvider>();
  const conversions = new Map<string, ConversionProvider>();
  return {
    registerService(p: ServiceProvider): void {
      if (services.has(p.id)) throw new RegistryError(`service provider "${p.id}" is already registered`);
      services.set(p.id, p);
    },
    registerConversion(p: ConversionProvider): void {
      if (conversions.has(p.name)) throw new RegistryError(`conversion provider "${p.name}" is already registered`);
      conversions.set(p.name, p);
    },
    serviceProviders: () => [...services.values()],
    conversionProviders: () => [...conversions.values()],
    conversion(name: string): ConversionProvider {
      const p = conversions.get(name);
      if (!p) throw new RegistryError(`no conversion provider named "${name}"`);
      return p;
    },
    /**
     * Find a service by id across providers. A provider that fails is skipped and reported, never fatal.
     * An id that appears under more than one provider is AMBIGUOUS and refused rather than guessed.
     */
    async findService(id: string): Promise<{ found: FoundService | undefined; errors: Array<{ provider: string; message: string }> }> {
      const matches: FoundService[] = [];
      const errors: Array<{ provider: string; message: string }> = [];
      for (const provider of services.values()) {
        try {
          const cat = await provider.catalog();
          const s = cat.services.find((x) => x.id === id);
          if (s) matches.push({ provider, service: s });
        } catch (e) {
          errors.push({ provider: provider.id, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
      if (matches.length > 1) {
        throw new RegistryError(`service id "${id}" exists in several providers (${matches.map((m) => m.provider.id).join(', ')}); refusing to guess`);
      }
      return { found: matches[0], errors };
    },
  };
}

/** The Buy gateway as a ServiceProvider. */
export function createBuyProvider(opts: { policy: SpendingPolicy; catalogUrl?: string; fetchImpl?: typeof fetch }): ServiceProvider {
  const client = createCatalogClient({ ...(opts.catalogUrl ? { url: opts.catalogUrl } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  return {
    id: 'buy-gateway',
    catalog: (o) => client.get(o ?? {}),
    discover: (service, body) =>
      discoverRequirements(service, body, { policy: opts.policy, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
  };
}
