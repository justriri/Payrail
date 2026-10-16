// DEVELOPMENT TESTS ONLY: failure-injection scenario names for the simulated providers, handed to the marketplace runtime as `dev`.
import { SIM_SCENARIOS } from './simfunding.ts';
import { SIM_FUNDING_SCENARIOS, SIM_PAYOUT_SCENARIOS } from './simconversion.ts';

export const DEV_SCENARIOS = { fundingScenarios: SIM_FUNDING_SCENARIOS, payoutScenarios: SIM_PAYOUT_SCENARIOS, legacyScenarios: SIM_SCENARIOS } as const;
