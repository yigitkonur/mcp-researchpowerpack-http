import { z } from 'zod';

export const startResearchParamsSchema = z.object({
  goal: z
    .string()
    .min(1, { message: 'start-research: goal cannot be empty' })
    .optional()
    .describe(
      'Research goal for this session. When provided, the server runs a one-shot LLM planner that returns a **goal-tailored research brief**: classified goal type (spec / bug / migration / sentiment / pricing / security / synthesis / product_launch), ordered source priorities, a Reddit-branch recommendation with reason, freshness target, 3–8 pre-built concept groups (25–50 total queries ready to fire in one web-search call), anticipated gaps to watch for, first-pass scrape targets, and success criteria. Without a goal you get the generic research-loop playbook only. Write the goal as you would to a human researcher — one or two sentences, specific about what "done" looks like.',
    ),
}).strict();

export const startResearchOutputSchema = z.object({
  content: z
    .string()
    .describe('Orientation markdown for the current research session.'),
}).strict();

export type StartResearchParams = z.infer<typeof startResearchParamsSchema>;
export type StartResearchOutput = z.infer<typeof startResearchOutputSchema>;
