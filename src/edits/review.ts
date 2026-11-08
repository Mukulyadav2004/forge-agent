import { z } from 'zod';

export const ProposalViewSchema = z.object({
  id: z.string(), path: z.string(), explanation: z.string(),
  status: z.enum(['pending', 'applied', 'rejected', 'conflict', 'superseded', 'undone']),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;
export const ReviewStateSchema = z.object({
  proposals: z.array(ProposalViewSchema), busy: z.boolean(), canUndo: z.boolean(),
  message: z.string(), recoveryPath: z.string().optional(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), id: z.string() }),
  z.object({ action: z.literal('apply'), id: z.string() }),
  z.object({ action: z.literal('reject'), id: z.string() }),
  z.object({ action: z.literal('apply_all') }),
  z.object({ action: z.literal('reject_all') }),
  z.object({ action: z.literal('undo') }),
]);
export type ReviewCommand = z.infer<typeof ReviewCommandSchema>;
