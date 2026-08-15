import { z } from 'zod'

const askUserQuestionOptionSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
})

/** Shared boundary schema for live and rehydrated human-interaction questions. */
export const askUserQuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(askUserQuestionOptionSchema).default([]),
  layout: z.enum(['compact', 'review-list']).optional(),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  allowEmpty: z.boolean().optional(),
  emptyLabel: z.string().optional(),
  minSelections: z.number().int().nonnegative().optional(),
  maxSelections: z.number().int().positive().optional(),
})
