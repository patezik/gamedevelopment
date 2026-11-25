import { sanatorium } from '../support/incident.ts';
import { historyProperty } from './history-sim.property.ts';

// A separate file so that Vitest runs the two scenarios in parallel.
historyProperty('sanatorium_winter', sanatorium, 1000);
