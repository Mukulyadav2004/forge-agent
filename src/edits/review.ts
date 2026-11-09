import { z } from 'zod';

export const HunkViewSchema = z.object({
  id: z.string(), oldStart: z.number().int().positive(), oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().positive(), newLines: z.number().int().nonnegative(),
  removed: z.string(), added: z.string(), truncated: z.boolean(),
  status: z.enum(['pending', 'applied', 'rejected', 'undone']),
});
export type HunkView = z.infer<typeof HunkViewSchema>;

export const ProposalViewSchema = z.object({
  id: z.string(), path: z.string(), explanation: z.string(),
  status: z.enum(['pending', 'applied', 'rejected', 'conflict', 'superseded', 'undone']),
  hunks: z.array(HunkViewSchema),
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
  z.object({ action: z.literal('apply_hunk'), id: z.string(), hunkId: z.string() }),
  z.object({ action: z.literal('reject_hunk'), id: z.string(), hunkId: z.string() }),
  z.object({ action: z.literal('apply_all') }),
  z.object({ action: z.literal('reject_all') }),
  z.object({ action: z.literal('undo') }),
]);
export type ReviewCommand = z.infer<typeof ReviewCommandSchema>;
