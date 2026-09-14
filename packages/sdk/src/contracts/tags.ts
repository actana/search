/**
 * Tag definitions: the names a KB gives its seventeen typed slots.
 *
 * A slot is a column on `document` and on every chunk it produced, so a tag
 * filter is an index scan rather than a join. The definition table is what maps
 * "Department" onto `tag3`; the value lives on the document.
 */

import { z } from "zod";
import { IsoDateTimeSchema, TagFieldTypeSchema } from "./common.ts";

export const TagDefinitionSchema = z.object({
  id: z.string(),
  knowledgeBaseId: z.string(),
  tagSlot: z.string(),
  displayName: z.string(),
  fieldType: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type TagDefinition = z.infer<typeof TagDefinitionSchema>;

export const ListTagDefinitionsResponseSchema = z.object({
  definitions: z.array(TagDefinitionSchema),
});
export type ListTagDefinitionsResponse = z.infer<typeof ListTagDefinitionsResponseSchema>;

/**
 * `PUT /v1/kbs/:id/tag-definitions` — the bulk create-or-update.
 *
 * `originalDisplayName` is how a rename is expressed: the definition is found
 * by the name it had, and renaming it rewrites the value on every document and
 * chunk that carried it.
 */
export const PutTagDefinitionsRequestSchema = z.object({
  definitions: z
    .array(
      z.object({
        tagSlot: z.string().min(1),
        displayName: z.string().min(1).max(200),
        fieldType: TagFieldTypeSchema,
        originalDisplayName: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(64),
});
export type PutTagDefinitionsRequest = z.infer<typeof PutTagDefinitionsRequestSchema>;

export const PutTagDefinitionsResponseSchema = z.object({
  created: z.array(TagDefinitionSchema),
  updated: z.array(TagDefinitionSchema),
  errors: z.array(z.string()),
});
export type PutTagDefinitionsResponse = z.infer<typeof PutTagDefinitionsResponseSchema>;

export const DeleteTagDefinitionResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteTagDefinitionResponse = z.infer<typeof DeleteTagDefinitionResponseSchema>;

/** `GET /v1/kbs/:id/tag-usage` — which documents carry which tag, and how many. */
export const TagUsageSchema = z.object({
  tagName: z.string(),
  tagSlot: z.string(),
  documentCount: z.number().int(),
  documents: z.array(
    z.object({ id: z.string(), name: z.string(), tagValue: z.string() }),
  ),
});
export type TagUsage = z.infer<typeof TagUsageSchema>;

export const TagUsageResponseSchema = z.object({ usage: z.array(TagUsageSchema) });
export type TagUsageResponse = z.infer<typeof TagUsageResponseSchema>;

/**
 * `GET /v1/kbs/:id/next-available-slot?fieldType=text`.
 *
 * `null` means every slot of that type is taken — seven text, five number, two
 * date, three boolean, and no eighteenth.
 */
export const NextAvailableSlotQuerySchema = z.object({ fieldType: TagFieldTypeSchema });
export type NextAvailableSlotQuery = z.infer<typeof NextAvailableSlotQuerySchema>;

export const NextAvailableSlotResponseSchema = z.object({
  fieldType: TagFieldTypeSchema,
  tagSlot: z.string().nullable(),
});
export type NextAvailableSlotResponse = z.infer<typeof NextAvailableSlotResponseSchema>;
