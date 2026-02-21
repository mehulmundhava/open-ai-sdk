import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

// configure env (works in both CJS and ESM)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// In-memory store: 1st tool writes plan, 2nd/3rd tools read it (planId required from 1st result)
const tripPlans = new Map();

// --- Tool 1: Must be called first. Returns planId + nextAction. Next tools need planId. ---

const resolveTrip = tool({
  name: 'resolve_trip',
  description: `Call this FIRST for any trip request. Give origin and destination. It returns a planId and nextAction.
Use the returned planId as input for get_flights and get_restaurants. Use nextAction to decide what to call next:
- "flights" -> call get_flights(planId) only
- "restaurants" -> call get_restaurants(planId) only  
- "both" -> call get_flights(planId) first, then get_restaurants(planId) with the same planId.`,
  parameters: z.object({
    origin: z.string().describe('Departure city'),
    destination: z.string().describe('Arrival city'),
  }),
  async execute({ origin, destination }) {
    console.log('[tool 1] resolve_trip:', origin, '->', destination);
    const planId = `P-${Date.now()}-${destination.slice(0, 2)}`;
    const nextAction = destination.toLowerCase().includes('paris') ? 'both' : 'flights';
    tripPlans.set(planId, { origin, destination });
    return JSON.stringify({
      planId,
      origin,
      destination,
      nextAction,
      message: `Plan created. nextAction=${nextAction}. Call get_flights(planId) and/or get_restaurants(planId) using this planId.`,
    });
  },
});

// --- Tool 2: Requires planId from resolve_trip result. Do not call before resolve_trip. ---

const getFlights = tool({
  name: 'get_flights',
  description: `Call AFTER resolve_trip. Requires planId from resolve_trip result (use the exact planId string returned).
Do not call without a planId from the first tool. Returns flights for that plan.`,
  parameters: z.object({
    planId: z.string().describe('planId from resolve_trip result - required'),
  }),
  async execute({ planId }) {
    console.log('[tool 2] get_flights planId:', planId);
    const plan = tripPlans.get(planId);
    if (!plan) return `Error: unknown planId "${planId}". Call resolve_trip first.`;
    const { origin, destination } = plan;
    return `Flights ${origin} → ${destination}: BA 123 08:00, AF 456 14:30. Prices from €89.`;
  },
});

// --- Tool 3: Requires planId from resolve_trip. First result's nextAction decides if you call this or get_flights or both. ---

const getRestaurants = tool({
  name: 'get_restaurants',
  description: `Call AFTER resolve_trip when nextAction is "restaurants" or "both". Requires planId from resolve_trip result.
Use the same planId from the first tool. Optional cuisine.`,
  parameters: z.object({
    planId: z.string().describe('planId from resolve_trip result - required'),
    cuisine: z.string().optional().nullable().describe('e.g. French, Italian'),
  }),
  async execute({ planId, cuisine }) {
    console.log('[tool 3] get_restaurants planId:', planId, 'cuisine:', cuisine ?? 'any');
    const plan = tripPlans.get(planId);
    if (!plan) return `Error: unknown planId "${planId}". Call resolve_trip first.`;
    const city = plan.destination;
    const type = cuisine || 'local';
    return `Restaurants in ${city} (${type}): Le Bistro (4.5★), La Table (4.2★).`;
  },
});

const agent = new Agent({
  name: 'Travel assistant',
  instructions: `You are a travel assistant. You MUST call tools in order:

1. Always call resolve_trip(origin, destination) FIRST. It returns planId and nextAction.
2. Use the returned planId for all following tool calls. Do NOT make up a planId.
3. Based on nextAction from step 1:
   - "flights" -> call get_flights(planId) only.
   - "restaurants" -> call get_restaurants(planId) only.
   - "both" -> call get_flights(planId) first, then get_restaurants(planId) with the SAME planId.
4. Never call get_flights or get_restaurants without first calling resolve_trip and using its planId.`,
  model: 'gpt-4.1',
  tools: [resolveTrip, getFlights, getRestaurants],
});

async function main() {
  const client = new OpenAI();
  const { id: conversationId } = await client.conversations.create({});
  console.log('conversationId:', conversationId);

  // Single message: agent must call resolve_trip -> then get_flights and get_restaurants (planId + nextAction from 1st)
  console.log('\n--- Message: trip Paris (1st tool → planId/nextAction → 2nd then 3rd tool with same planId) ---');
  const result = await run(
    agent,
    'I want to go from London to Paris. I need flights and a dinner restaurant.',
    { conversationId }
  );
  console.log('Final:', result.finalOutput);

  // Follow-up in same conversation – must also call tools (new trip = new resolve_trip → get_flights / get_restaurants)
  console.log('\n--- Follow-up (same conversationId, requires tool calls again) ---');
  const result2 = await run(
    agent,
    'Now plan a trip from Paris to Berlin: I need flights and a good restaurant for dinner there. which trip is better-?',
    { conversationId }
  );
  console.log('Final:', result2.finalOutput);
}

main().catch(console.error);
